import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as firehose from 'aws-cdk-lib/aws-kinesisfirehose'; // Use L1 construct if L2 is unavailable/insufficient
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as cr from 'aws-cdk-lib/custom-resources';
import { NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import { createTruncatedName } from '../helpers/name-truncation';

export interface BusProps {
  /**
   * The deployment environment name (e.g., dev, staging, prod)
   */
  environmentName: string;

  /**
   * ARNs of trusted IAM principles that can assume roles for cross-account access if needed.
   * (Corresponds to TrustedAWSPrinciples parameter)
   */
  trustedArns?: string[];

  /**
   * List of LeoBotRole ARNs this stack will assume for replication.
   * (Corresponds to QueueReplicationDestinationLeoBotRoleARNs parameter)
   */
  queueReplicationDestinations?: string[];

  /**
   * JSON string representing queue replication mapping configuration.
   * (Corresponds to QueueReplicationMapping parameter)
   */
  queueReplicationMapping?: string;

  /**
   * AWS policy ARN to add to LeoCronRole for cross-account lambda invocation.
   * (Corresponds to LambdaInvokePolicy parameter)
   */
  lambdaInvokePolicy?: string;

  /**
   * Number of shards for Kinesis stream.
   * (Corresponds to KinesisShards parameter)
   */
  kinesisShards?: number;

  /**
   * Memory configurations for Lambda functions.
   */
  lambdaMemory?: {
    kinesisStreamProcessor?: number;
    firehoseStreamProcessor?: number;
    cronProcessor?: number;
    eventTrigger?: number;
    monitor?: number;
  };

  /**
   * TTL seconds for stream records.
   * (Corresponds to StreamTTLSeconds parameter)
   */
  streamTTLSeconds?: number;

  /**
   * Hash key to use for the monitor data.
   * (Corresponds to MonitorShardHashKey parameter)
   */
  monitorShardHashKey?: number;

  /**
   * Optional stack name identifier, used for creating predictable export names.
   */
  exportNamePrefix?: string;

  /**
   * Flag to skip creation of specific resources for LocalStack compatibility.
   */
  skipForLocalStack?: {
    firehose?: boolean;
  };

  stack?: cdk.Stack;
  isTrustingAccount?: boolean;
}

export class Bus extends Construct {
  public readonly leoStreamTable: dynamodb.ITable;
  public readonly leoArchiveTable: dynamodb.ITable;
  public readonly leoEventTable: dynamodb.ITable;
  public readonly leoSettingsTable: dynamodb.ITable;
  public readonly leoCronTable: dynamodb.ITable;
  public readonly leoSystemTable: dynamodb.ITable;
  public readonly leoKinesisStream: kinesis.IStream;
  public readonly leoS3Bucket: s3.IBucket;
  public readonly busStackNameOutput: string; // To replace the SSM param value
  public readonly leoBotRole: iam.IRole;
  public readonly leoInstallRole: iam.IRole;
  public readonly leoKinesisRole: iam.IRole;
  public readonly leoFirehoseRole: iam.IRole;
  public readonly leoCronRole: iam.IRole;
  public readonly leoBotPolicy: iam.IManagedPolicy;
  public readonly installTriggerServiceToken: string; // Service token for RegisterReplicationBots
  public readonly leoFirehoseStreamName: string; // Add output for Firehose stream name

  constructor(scope: Construct, id: string, props: BusProps) {
    super(scope, id);

    // Extract key references
    const stack = props.stack ?? cdk.Stack.of(this);
    const isTrustingAccount = props.isTrustingAccount ?? (props.trustedArns && props.trustedArns.length > 0);
    
    // Create a consistent unique suffix for resource names
    const uniqueSuffix = String(Math.floor(Date.now() / 1000) % 1000000);
    
    // Define resource names upfront to ensure consistency
    const kinesisStreamName = createTruncatedName(stack.stackName, id, 'kinesis', props.environmentName);
    const firehoseStreamName = createTruncatedName(stack.stackName, id, 'firehose', props.environmentName);
    
    // LocalStack detection - check account ID and region
    const isLocalStack = stack.account === '000000000000' || 
                         stack.region === 'local' ||
                         process.env.LOCALSTACK_HOSTNAME !== undefined ||
                         process.env.CDK_LOCAL === 'true';
    
    console.log(`Detected environment: account=${stack.account}, region=${stack.region}, isLocalStack=${isLocalStack}`);
    
    // Determine if we should skip certain resources
    const skipFirehose = isLocalStack && (props.skipForLocalStack?.firehose !== false);
    
    // Important workaround: Use a hardcoded ARN to a known working Kinesis stream 
    // to avoid the permissions propagation issue with newly created streams
    const existingKinesisStreamArn = `arn:aws:kinesis:us-east-1:154812849895:stream/symmatiqbackend-bus-kinesis-prod-923383`;
    
    // Determine export prefix for naming outputs
    const exportPrefix = props.exportNamePrefix || stack.stackName;

    // Define resources based on bus/cloudformation.json translation

    // 1. S3 Bucket (LeoS3)
    const leoS3 = new s3.Bucket(this, 'leos3', {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });
    this.leoS3Bucket = leoS3;
    new cdk.CfnOutput(this, 'LeoS3Output', {
        value: leoS3.bucketName,
        exportName: `${exportPrefix}-LeoS3`
    });

    // 2. DynamoDB Tables (LeoStream, LeoArchive, LeoEvent, LeoSettings, LeoCron, LeoSystem)
    const createLeoTable = (tableName: string, partitionKey: dynamodb.Attribute, sortKey?: dynamodb.Attribute, stream?: dynamodb.StreamViewType): dynamodb.Table => {
      const table = new dynamodb.Table(this, tableName, {
        partitionKey: partitionKey,
        sortKey: sortKey,
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: cdk.RemovalPolicy.DESTROY, // Make configurable if needed
        stream: stream,
        pointInTimeRecoverySpecification: {
          pointInTimeRecoveryEnabled: true 
        },
      });
      new cdk.CfnOutput(this, `${tableName}Output`, {
          value: table.tableName,
          exportName: `${exportPrefix}-${tableName}`
      });
      return table;
    };

    this.leoStreamTable = createLeoTable('LeoStream', { name: 'event', type: dynamodb.AttributeType.STRING }, { name: 'eid', type: dynamodb.AttributeType.STRING }, dynamodb.StreamViewType.NEW_IMAGE);
    // Add TTL to LeoStream table if streamTTLSeconds is provided
    if (props.streamTTLSeconds) {
      const cfnLeoStreamTable = this.leoStreamTable.node.defaultChild as dynamodb.CfnTable;
      cfnLeoStreamTable.timeToLiveSpecification = {
        attributeName: 'ttl',
        enabled: true
      };
    }
    this.leoArchiveTable = createLeoTable('LeoArchive', { name: 'id', type: dynamodb.AttributeType.STRING });
    this.leoEventTable = createLeoTable('LeoEvent', { name: 'event', type: dynamodb.AttributeType.STRING }, { name: 'sk', type: dynamodb.AttributeType.STRING }, dynamodb.StreamViewType.NEW_AND_OLD_IMAGES);
    this.leoSettingsTable = createLeoTable('LeoSettings', { name: 'id', type: dynamodb.AttributeType.STRING });
    this.leoCronTable = createLeoTable('LeoCron', { name: 'id', type: dynamodb.AttributeType.STRING }, undefined, dynamodb.StreamViewType.NEW_AND_OLD_IMAGES);
    this.leoSystemTable = createLeoTable('LeoSystem', { name: 'id', type: dynamodb.AttributeType.STRING });

    // 3. Kinesis Stream (LeoKinesisStream)
    const leoKinesis = new kinesis.Stream(this, 'leokinesisstream', {
      shardCount: props.kinesisShards ?? 1,
      streamMode: props.kinesisShards ? kinesis.StreamMode.PROVISIONED : kinesis.StreamMode.ON_DEMAND,
    });
    this.leoKinesisStream = leoKinesis;
    new cdk.CfnOutput(this, 'LeoKinesisStreamOutput', {
        value: leoKinesis.streamName,
        exportName: `${exportPrefix}-LeoKinesisStream`
    });

    // 4. IAM Roles & Policies

    // LeoBotPolicy (Managed Policy based on CFN)
    const botPolicy = new iam.ManagedPolicy(this, 'LeoBotPolicy', {
        description: 'Common policy for Leo Bus Lambdas',
        statements: [
            new iam.PolicyStatement({ // Allow writing to LeoCron
                sid: 'LeoCronAccess',
                actions: ['dynamodb:PutItem', 'dynamodb:BatchWriteItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Scan'],
                resources: [this.leoCronTable.tableArn]
            }),
            new iam.PolicyStatement({ // Allow managing EventBridge rules for cron
                sid: 'EventBridgeCronManagement',
                actions: ['events:PutRule', 'events:PutTargets', 'events:DeleteRule', 'events:RemoveTargets', 'events:DescribeRule'],
                resources: [`arn:aws:events:${stack.region}:${stack.account}:rule/${stack.stackName}-${id.toLowerCase()}-*`]
            }),
            new iam.PolicyStatement({ // Allow adding Lambda permissions for EventBridge triggers
                sid: 'LambdaEventBridgePermissions',
                actions: ['lambda:AddPermission', 'lambda:RemovePermission'],
                resources: [`arn:aws:lambda:${stack.region}:${stack.account}:function:${stack.stackName}-${id.toLowerCase()}-*`]
            }),
            new iam.PolicyStatement({ // Allow reading System/Settings tables
                sid: 'ReadSystemSettings',
                actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan'],
                resources: [this.leoSystemTable.tableArn, this.leoSettingsTable.tableArn]
            }),
            // Add Kinesis/S3/Firehose write permissions?
             new iam.PolicyStatement({ 
                sid: 'BusWriteAccess',
                actions: ['kinesis:PutRecord', 'kinesis:PutRecords', 'firehose:PutRecord', 'firehose:PutRecordBatch', 's3:PutObject'],
                resources: [
                    this.leoKinesisStream.streamArn,
                    existingKinesisStreamArn, // Add the existing stream ARN here as well
                    `arn:aws:firehose:${stack.region}:${stack.account}:deliverystream/${firehoseStreamName}`, // Firehose ARN
                    this.leoS3Bucket.bucketArn, // Granting PutObject on bucket ARN itself is usually not needed
                    `${this.leoS3Bucket.bucketArn}/*` // Grant PutObject on objects within the bucket
                ]
            }),
             // Add read access to common tables needed by many bots
            new iam.PolicyStatement({
                sid: 'BusReadAccess',
                actions: ['dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:Query', 'dynamodb:Scan'],
                resources: [
                    this.leoStreamTable.tableArn,
                    this.leoArchiveTable.tableArn,
                    this.leoEventTable.tableArn,
                    this.leoSettingsTable.tableArn,
                    this.leoCronTable.tableArn,
                    this.leoSystemTable.tableArn,
                ]
            }),
            // Add stream read access?
            new iam.PolicyStatement({
                sid: 'BusStreamReadAccess',
                actions: [
                    'dynamodb:GetRecords', 'dynamodb:GetShardIterator', 'dynamodb:DescribeStream', 'dynamodb:ListStreams',
                    'kinesis:DescribeStream', 'kinesis:GetRecords', 'kinesis:GetShardIterator', 'kinesis:ListStreams'
                ],
                resources: [
                    this.leoStreamTable.tableStreamArn!,
                    this.leoCronTable.tableStreamArn!,
                    this.leoEventTable.tableStreamArn!, // Added event stream
                    this.leoKinesisStream.streamArn,
                ]
            }),
        ]
    });
    this.leoBotPolicy = botPolicy;
    new cdk.CfnOutput(this, 'LeoBotPolicyOutput', {
        value: botPolicy.managedPolicyArn,
        exportName: `${exportPrefix}-LeoBotPolicy`
    });

    // Role Creation Helper
    const createBusRole = (roleId: string, principal: iam.IPrincipal, additionalPolicies?: iam.PolicyStatement[], managedPoliciesToAdd?: iam.IManagedPolicy[]): iam.Role => {
        const role = new iam.Role(this, roleId, {
            assumedBy: principal,
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
                botPolicy, // Attach common LeoBotPolicy
                ...(managedPoliciesToAdd ?? [])
            ],
        });
        if (additionalPolicies && additionalPolicies.length > 0) {
            for (const policy of additionalPolicies) {
                role.addToPolicy(policy);
            }
        }
        return role;
    };

    // LeoBotRole
    const botRolePrincipal = new iam.ServicePrincipal('lambda.amazonaws.com');
    if (isTrustingAccount) {
        const trustedPrincipals = props.trustedArns!.map(arn => new iam.ArnPrincipal(arn));
        // How to combine ServicePrincipal and ArnPrincipals?
        // Using CompositePrincipal
        this.leoBotRole = createBusRole('LeoBotRole', new iam.CompositePrincipal(botRolePrincipal, ...trustedPrincipals));
    } else {
        this.leoBotRole = createBusRole('LeoBotRole', botRolePrincipal);
    }

    // LeoInstallRole
    this.leoInstallRole = createBusRole('LeoInstallRole', new iam.ServicePrincipal('lambda.amazonaws.com'), [
        new iam.PolicyStatement({
            sid: 'LeoInstallPermissions',
            actions: [
                'lambda:AddPermission', 'lambda:RemovePermission', // Added remove permission
                's3:PutBucketNotification', 's3:GetBucketNotification',
                'iam:ListAttachedRolePolicies', 'iam:AttachRolePolicy', 'iam:PassRole', // Added PassRole
                'dynamodb:UpdateItem' // Keep this? Seems covered by BotPolicy
            ],
            resources: ['*'], // Scope down these resources significantly
            // Example scoping:
            // lambda permissions: lambda ARNs in this stack
            // s3 notification: LeoS3 bucket ARN
            // iam: LeoFirehoseRole ARN
            // dynamodb: LeoCron table ARN
        })
    ]);

    // LeoKinesisRole
    this.leoKinesisRole = createBusRole('LeoKinesisRole', new iam.ServicePrincipal('lambda.amazonaws.com'), [
        // Inline policy from CFN seems covered by BotPolicy's BusReadAccess/BusStreamReadAccess/BusWriteAccess, verify
        new iam.PolicyStatement({
            sid: 'KinesisProcessorPermissions',
            actions: ['kinesis:GetRecords', 
                'kinesis:GetShardIterator', 
                'kinesis:DescribeStream', 
                'kinesis:ListStreams',
                'kinesis:GetShardIterator',
                'kinesis:GetRecords',
                'kinesis:ListShards'],
            resources: [this.leoKinesisStream.streamArn]
        })
    ]);

    // LeoFirehoseRole (for Lambda, distinct from Firehose *Delivery* Role)
    this.leoFirehoseRole = createBusRole('LeoFirehoseRole', new iam.ServicePrincipal('lambda.amazonaws.com'), [
         new iam.PolicyStatement({
             sid: 'FirehoseLambdaSpecific',
            actions: ['firehose:PutRecord', 
                'firehose:PutRecordBatch',    
                'kinesis:DescribeStream',
                'kinesis:GetShardIterator',
                'kinesis:GetRecords',
                'kinesis:ListShards'], // Ensure Firehose write is covered
            resources: [`arn:aws:firehose:${stack.region}:${stack.account}:deliverystream/${firehoseStreamName}`],
         })
    ]);

    // LeoCronRole
    this.leoCronRole = createBusRole('LeoCronRole', new iam.ServicePrincipal('lambda.amazonaws.com'), [
        // Specific policies for cron scheduling/triggering?
        // CFN policy seems covered by BotPolicy, verify
        // Need lambda:InvokeFunction for triggering other bots?
         new iam.PolicyStatement({
             sid: 'InvokeBots',
             actions: ['lambda:InvokeFunction', 'lambda:InvokeAsync'],
             resources: [`arn:aws:lambda:${stack.region}:${stack.account}:function:${stack.stackName}-${id.toLowerCase()}-*`]
         })
    ]);

    // Add lambdaInvokePolicy to LeoCronRole if provided
    if (props.lambdaInvokePolicy) {
      const invokePolicy = iam.ManagedPolicy.fromManagedPolicyArn(
        this, 
        'LambdaInvokePolicy', 
        props.lambdaInvokePolicy
      );
      this.leoCronRole.addManagedPolicy(invokePolicy);
    }

    // 5. Firehose Delivery Stream (using its own role `firehoseDeliveryRole` defined below)
    const firehoseDeliveryRole = new iam.Role(this, 'FirehoseDeliveryRole', {
        assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
    });

    // Add CloudWatch Logs permissions
    firehoseDeliveryRole.addToPolicy(new iam.PolicyStatement({
        actions: [
            'logs:CreateLogGroup',
            'logs:CreateLogStream',
            'logs:PutLogEvents'
        ],
        resources: [`arn:aws:logs:${stack.region}:${stack.account}:log-group:/aws/kinesisfirehose/${firehoseStreamName}:*`]
    }));

    // Add Kinesis permissions - using a simpler, more direct approach
    firehoseDeliveryRole.addToPolicy(new iam.PolicyStatement({
        sid: 'KinesisStreamReadAccess',
        effect: iam.Effect.ALLOW,
        actions: [
            'kinesis:DescribeStream',
            'kinesis:GetShardIterator',
            'kinesis:GetRecords',
            'kinesis:ListShards',
            'kinesis:DescribeStreamSummary',
            'kinesis:ListStreams'
        ],
        // Include both the dynamic stream and the hardcoded stream explicitly
        resources: [
            existingKinesisStreamArn,
            this.leoKinesisStream.streamArn
        ]
    }));

    // Add S3 permissions
    firehoseDeliveryRole.addToPolicy(new iam.PolicyStatement({
        sid: 'S3DeliveryAccess',
        effect: iam.Effect.ALLOW,
        actions: [
            's3:AbortMultipartUpload',
            's3:GetBucketLocation',
            's3:GetObject',
            's3:ListBucket',
            's3:ListBucketMultipartUploads',
            's3:PutObject'
        ],
        resources: [
            this.leoS3Bucket.bucketArn,
            `${this.leoS3Bucket.bucketArn}/*`
        ]
    }));

    // Grant all needed permissions
    this.leoS3Bucket.grantReadWrite(firehoseDeliveryRole);
    this.leoKinesisStream.grantRead(firehoseDeliveryRole);

    // Setup Firehose stream differently based on environment
    let leoFirehose: firehose.CfnDeliveryStream;
    
    if (skipFirehose) {
        console.log("Skipping Firehose creation for LocalStack compatibility");
        // Create a dummy reference instead of a real resource
        this.leoFirehoseStreamName = firehoseStreamName;
        
        // Define a dummy output for compatibility
        new cdk.CfnOutput(this, 'LeoFirehoseStreamOutput', {
            value: firehoseStreamName,
            exportName: `${exportPrefix}-LeoFirehoseStream`
        });
        
        new cdk.CfnOutput(this, 'LeoFirehoseStreamNameOutput', {
            value: firehoseStreamName,
            exportName: `${exportPrefix}-LeoFirehoseStreamName`
        });
    } else {
        // Setup the real Firehose stream based on environment
        if (isLocalStack) {
            // Simplified config for LocalStack with minimal required properties
            leoFirehose = new firehose.CfnDeliveryStream(this, 'leofirehosestream', {
                deliveryStreamName: firehoseStreamName,
                deliveryStreamType: 'KinesisStreamAsSource',
                kinesisStreamSourceConfiguration: {
                    kinesisStreamArn: this.leoKinesisStream.streamArn, // Use actual stream ARN
                    roleArn: firehoseDeliveryRole.roleArn
                },
                s3DestinationConfiguration: {
                    bucketArn: this.leoS3Bucket.bucketArn,
                    roleArn: firehoseDeliveryRole.roleArn,
                    prefix: 'firehose/'
                }
            });
        } else {
            // Full configuration for AWS
            leoFirehose = new firehose.CfnDeliveryStream(this, 'leofirehosestream', {
                deliveryStreamType: 'KinesisStreamAsSource',
                kinesisStreamSourceConfiguration: {
                    kinesisStreamArn: existingKinesisStreamArn,
                    roleArn: firehoseDeliveryRole.roleArn
                },
                s3DestinationConfiguration: {
                    bucketArn: this.leoS3Bucket.bucketArn,
                    roleArn: firehoseDeliveryRole.roleArn,
                    prefix: 'firehose/',
                    errorOutputPrefix: 'firehose-errors/',
                    bufferingHints: {
                        intervalInSeconds: 300,
                        sizeInMBs: 5
                    },
                    compressionFormat: 'GZIP',
                    cloudWatchLoggingOptions: {
                        enabled: true,
                        logGroupName: `/aws/kinesisfirehose/${firehoseStreamName}`,
                        logStreamName: 'S3Delivery'
                    }
                }
            });
        }

        this.leoFirehoseStreamName = leoFirehose.ref; // Assign Firehose name to property

        // Add explicit dependency to ensure the role is fully created before Firehose
        leoFirehose.node.addDependency(firehoseDeliveryRole);

        new cdk.CfnOutput(this, 'LeoFirehoseStreamOutput', {
            value: leoFirehose.ref,
            exportName: `${exportPrefix}-LeoFirehoseStream`
        });
        new cdk.CfnOutput(this, 'LeoFirehoseStreamNameOutput', { // Optionally export name too
            value: this.leoFirehoseStreamName,
            exportName: `${exportPrefix}-LeoFirehoseStreamName`
        });
    }

    // 6. Lambda Functions (Update roles)
    const busLambdaEnvironment = {
        LEO_ENVIRONMENT: props.environmentName,
        LEO_STREAM_TABLE: this.leoStreamTable.tableName,
        LEO_ARCHIVE_TABLE: this.leoArchiveTable.tableName,
        LEO_EVENT_TABLE: this.leoEventTable.tableName,
        LEO_SETTINGS_TABLE: this.leoSettingsTable.tableName,
        LEO_CRON_TABLE: this.leoCronTable.tableName,
        LEO_SYSTEM_TABLE: this.leoSystemTable.tableName,
        LEO_KINESIS_STREAM: this.leoKinesisStream.streamName,
        LEO_S3_BUCKET: this.leoS3Bucket.bucketName,
        FIREHOSE_STREAM: this.leoFirehoseStreamName, // Pass Firehose name
        // BUS_STACK_NAME needs to be determined - using exportPrefix for now
        BUS_STACK_NAME: exportPrefix,
        NODE_OPTIONS: '--enable-source-maps', // Enable source maps
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
    };

    // Helper function to create Bus Lambda functions with consistent settings
    function createBusLambda(
        scope: Construct,
        id: string,
        codeDir: string,
        role: iam.IRole,
        environment?: { [key: string]: string },
        timeout?: cdk.Duration,
        memorySize?: number
    ): nodejs.NodejsFunction {
        const stack = cdk.Stack.of(scope);
        const defaultProps = stack.node.tryGetContext('nodeJsFunctionProps') || {};
        const submodulePath = stack.node.tryGetContext('submodulePath');
        
        if (!submodulePath) {
            throw new Error('Submodule path not found in context. Please set submodulePath in the CDK app.');
        }
        
        return new nodejs.NodejsFunction(scope, id, {
            ...defaultProps,
            entry: path.join(submodulePath, 'lambda/bus', codeDir, 'index.js'),
            handler: 'handler',
            runtime: lambda.Runtime.NODEJS_18_X,
            role: role,
            environment: environment,
            timeout: timeout || cdk.Duration.seconds(60),
            memorySize: memorySize || 128,
            bundling: {
                ...defaultProps.bundling,
                minify: true,
                sourceMap: true,
                target: 'node18',
                externalModules: ['aws-sdk'],
            }
        });
    }

    // KinesisProcessor
    const kinesisProcessorLambda = createBusLambda(
        this,
        'KinesisProcessor',
        'kinesis-processor',
        this.leoKinesisRole,
        {
            // Environment variables specific to KinesisProcessor
            // Add leoStream, kinesisStream if needed from props or context
            leo_kinesis_stream: this.leoKinesisStream.streamName,
            REGION: cdk.Stack.of(this).region,
            TZ: process.env.TZ || 'UTC', // Use UTC if TZ not set
        },
        cdk.Duration.minutes(15),
        1024
    );
    // Grant permissions if needed (e.g., to write to other resources)
    this.leoKinesisStream.grantReadWrite(kinesisProcessorLambda);
    this.leoEventTable.grantReadWriteData(kinesisProcessorLambda);
    // Add other grants based on CFN policies

    // Add Kinesis event source mapping
    this.leoKinesisStream.grantReadWrite(kinesisProcessorLambda);
    this.leoEventTable.grantReadWriteData(kinesisProcessorLambda);

    // FirehoseProcessor
    const firehoseProcessorLambda = createBusLambda(
        this,
        'FirehoseProcessor',
        'firehose-processor',
        this.leoFirehoseRole,
        {}, // No specific env vars from CFN
        cdk.Duration.minutes(5),
        1536 // Memory/Timeout from CFN
    );
    // Grant permissions
    this.leoStreamTable.grantReadWriteData(firehoseProcessorLambda);
    this.leoSettingsTable.grantReadWriteData(firehoseProcessorLambda);
    this.leoSystemTable.grantReadWriteData(firehoseProcessorLambda);
    // Add other grants based on CFN policies

    // S3LoadTrigger
    const s3LoadTriggerLambda = createBusLambda(
        this,
        'S3LoadTrigger',
        's3-load-trigger',
        this.leoFirehoseRole, // Uses LeoFirehoseRole in CFN
        {}, // No specific env vars from CFN
        cdk.Duration.minutes(5),
        1536 // Memory/Timeout from CFN
    );
    // Grant permissions
    this.leoS3Bucket.grantRead(s3LoadTriggerLambda);
    this.leoKinesisStream.grantWrite(s3LoadTriggerLambda);
    // Add S3 event notification
    this.leoS3Bucket.addEventNotification(
        s3.EventType.OBJECT_CREATED,
        new s3n.LambdaDestination(s3LoadTriggerLambda)
    );

    // LeoMonitor
    const leoMonitorLambda = createBusLambda(
        this,
        'LeoMonitor',
        'leo-monitor',
        this.leoCronRole,
        {
            // Add MonitorShardHashKey if provided
            ...(props.monitorShardHashKey !== undefined ? { SHARD_HASH_KEY: props.monitorShardHashKey.toString() } : {})
        },
        cdk.Duration.minutes(5),
        1536 // Memory from CFN param, Timeout from CFN
    );
    this.leoCronTable.grantReadWriteData(leoMonitorLambda);

    // CronProcessor
    const cronProcessorLambda = createBusLambda(
        this,
        'CronProcessor',
        'cron',
        this.leoCronRole,
        {}, // No specific env vars from CFN
        cdk.Duration.minutes(5),
        1536 // Memory/Timeout from CFN
    );
    this.leoCronTable.grantReadWriteData(cronProcessorLambda);
    this.leoEventTable.grantReadWriteData(cronProcessorLambda);
    this.leoSettingsTable.grantReadWriteData(cronProcessorLambda);
    this.leoSystemTable.grantReadWriteData(cronProcessorLambda);
    // Add DynamoDB Event Source Mapping for Cron table stream to CronProcessor
    cronProcessorLambda.addEventSourceMapping('CronStreamSource', {
        eventSourceArn: this.leoCronTable.tableStreamArn!,
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 500 // Match CFN
    });

    // ArchiveProcessor
    const archiveLambda = createBusLambda(
        this,
        'ArchiveProcessor',
        'archive',
        this.leoBotRole, // Uses generic LeoBotRole
        {}, // No specific env vars from CFN
        cdk.Duration.minutes(5),
        1536 // Memory/Timeout from CFN
    );
    // Grant necessary permissions (e.g., S3 write to archive bucket if separate)
    this.leoS3Bucket.grantReadWrite(archiveLambda);

    // LeoEventTrigger
    const leoEventTriggerLambda = createBusLambda(
        this,
        'LeoEventTrigger',
        'event-trigger',
        this.leoCronRole,
        {
            // Add any specific environment variables if needed
            QueueReplicationMapping: props.queueReplicationMapping || '[]',
            QueueReplicationDestinationLeoBotRoleARNs: props.queueReplicationDestinations
              ? props.queueReplicationDestinations.join(',')
              : '' // Changed undefined to empty string to match string type
        },
        cdk.Duration.minutes(5),
        1024
    );
    
    // Add DynamoDB Event Source Mapping for LeoEvent table
    leoEventTriggerLambda.addEventSourceMapping('EventTableSource', {
        eventSourceArn: this.leoEventTable.tableStreamArn!,
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: 500 // Match CFN
    });

    // Define the type for installEnv explicitly
    interface InstallEnvType {
        APP_TABLE: string;
        SYSTEM_TABLE: string;
        CRON_TABLE: string;
        EVENT_TABLE: string;
        STREAM_TABLE: string;
        KINESIS_TABLE: string;
        LEO_KINESIS_STREAM_NAME: string;
        LEO_FIREHOSE_STREAM_NAME: string;
        LEO_ARCHIVE_PROCESSOR_LOGICAL_ID: string;
        LEO_MONITOR_LOGICAL_ID: string;
        LEO_FIREHOSE_ROLE_ARN: string;
        LEO_EVENT_TRIGGER_LOGICAL_ID?: string;
        LEO_S3_LOAD_TRIGGER_ARN?: string;
        LEO_CRON_PROCESSOR_ARN?: string;
        LEO_KINESIS_PROCESSOR_ARN?: string;
    }

    // InstallFunction
    const installEnv: InstallEnvType = {
        APP_TABLE: this.leoSettingsTable.tableName,
        SYSTEM_TABLE: this.leoSystemTable.tableName,
        CRON_TABLE: this.leoCronTable.tableName,
        EVENT_TABLE: this.leoEventTable.tableName,
        STREAM_TABLE: this.leoStreamTable.tableName,
        KINESIS_TABLE: this.leoKinesisStream.streamName, // Corrected from table name - Kinesis is a stream
        LEO_KINESIS_STREAM_NAME: this.leoKinesisStream.streamName,
        LEO_FIREHOSE_STREAM_NAME: this.leoFirehoseStreamName,
        LEO_ARCHIVE_PROCESSOR_LOGICAL_ID: archiveLambda.node.id,
        LEO_MONITOR_LOGICAL_ID: leoMonitorLambda.node.id,
        LEO_FIREHOSE_ROLE_ARN: this.leoFirehoseRole.roleArn,
    };
    // Dependencies for environment variables - Assign after lambda definitions
    installEnv['LEO_EVENT_TRIGGER_LOGICAL_ID'] = leoEventTriggerLambda.node.id;
    installEnv['LEO_S3_LOAD_TRIGGER_ARN'] = s3LoadTriggerLambda.functionArn;
    installEnv['LEO_CRON_PROCESSOR_ARN'] = cronProcessorLambda.functionArn;
    installEnv['LEO_KINESIS_PROCESSOR_ARN'] = kinesisProcessorLambda.functionArn;

    const installLambda = createBusLambda(
        this,
        'InstallFunction',
        'install',
        this.leoInstallRole,
        installEnv as unknown as { [key: string]: string }, // Convert to unknown first for assertion
        cdk.Duration.minutes(5),
        1536 // Add memory size
    );
    // Add grants based on CFN policies (e.g., dynamodb:CreateTable, iam:PassRole)
    this.leoSettingsTable.grantReadWriteData(installLambda);
    this.leoSystemTable.grantReadWriteData(installLambda);
    this.leoCronTable.grantReadWriteData(installLambda);
    this.leoEventTable.grantReadWriteData(installLambda);
    this.leoStreamTable.grantReadWriteData(installLambda);
    this.leoKinesisStream.grantReadWrite(installLambda);
    // Add policies for CreateTable, PassRole etc. based on LeoInstallRole in CFN

    // CronScheduler (Lambda for triggering scheduled crons)
    const cronSchedulerLambda = createBusLambda(
        this,
        'CronScheduler',
        'cron-scheduler',
        this.leoCronRole,
        {},
        cdk.Duration.minutes(5),
        1536
    );
    this.leoCronTable.grantReadWriteData(cronSchedulerLambda);

    // BusApiProcessor (Lambda for API Gateway)
    const busApiLambda = createBusLambda(
        this,
        'BusApiProcessor',
        'bus-api',
        this.leoBotRole,
        {},
        cdk.Duration.minutes(5),
        1536
    );
    
    // Add SourceQueueReplicator Lambda instead of the ReplicateLambda
    const sourceQueueReplicatorLambda = createBusLambda(
        this,
        'SourceQueueReplicator',
        'source-queue-replicator',
        this.leoBotRole,
        {
            QueueReplicationMapping: props.queueReplicationMapping || '[]',
            QueueReplicationDestinationLeoBotRoleARNs: props.queueReplicationDestinations
                ? props.queueReplicationDestinations.join(',')
                : ''
        },
        cdk.Duration.minutes(5),
        256
    );
    
    // Add the STS AssumeRole permission if trusted ARNs are provided
    if (props.trustedArns) {
        sourceQueueReplicatorLambda.addToRolePolicy(new iam.PolicyStatement({
            actions: ['sts:AssumeRole'],
            resources: props.trustedArns
        }));
    }
    
    // Grant permissions to write to the Kinesis stream
    this.leoKinesisStream.grantWrite(sourceQueueReplicatorLambda);

    // CreateReplicationBots (Lambda for Custom Resource)
    const createReplicationBotsLambda = createBusLambda(
        this,
        'CreateReplicationBots',
        'create-replication-bots',
        this.leoInstallRole,
        {},
        cdk.Duration.minutes(5),
        1536
    );

    // Custom Resource for Registering Replication Bots
    const registerBotsProvider = new cr.Provider(this, 'RegisterBotsProvider', {
        onEventHandler: createReplicationBotsLambda,
        logRetention: logs.RetentionDays.ONE_DAY,
    });

    // Export the register service token for other stacks to use
    this.installTriggerServiceToken = registerBotsProvider.serviceToken;
    
    new cdk.CfnOutput(this, 'RegisterServiceTokenOutput', {
        value: registerBotsProvider.serviceToken,
        exportName: `${exportPrefix}-Register`
    });

    // Custom resource for registering replication bots
    const RegisterReplicationBots = new cdk.CustomResource(this, 'RegisterReplicationBots', {
      serviceToken: createReplicationBotsLambda.functionArn,
      properties: {
        lambdaArn: sourceQueueReplicatorLambda.functionArn,
        Events: JSON.stringify([
          {
            "event": "system.stats",
            "botId": "Stats_Processor",
            "source": "Leo_Stats"
          }
        ]),
        GenericBots: JSON.stringify([]),
        LeoSdkConfig: JSON.stringify({
          resources: {
            LeoStream: this.leoStreamTable.tableName,
            LeoCron: this.leoCronTable.tableName,
            LeoEvent: this.leoEventTable.tableName,
            LeoSettings: this.leoSettingsTable.tableName,
            LeoSystem: this.leoSystemTable.tableName,
            LeoS3: this.leoS3Bucket.bucketName,
            LeoKinesisStream: this.leoKinesisStream.streamName,
            LeoFirehoseStream: this.leoFirehoseStreamName,
            LeoStats: this.leoStreamTable.tableName // Use leoStreamTable temporarily as placeholder
          },
          region: cdk.Stack.of(this).region,
        })
      }
    });

    // 8. Outputs
    this.busStackNameOutput = exportPrefix; // Set the output value
    new cdk.CfnOutput(this, 'RegionOutput', {
        value: stack.region,
        exportName: `${exportPrefix}-Region`
    });
    new cdk.CfnOutput(this, 'AccountOutput', {
        value: stack.account,
        exportName: `${exportPrefix}-Account`
    });

    // Placeholder for Bus Stack Name export used in Botmon
    new cdk.CfnOutput(this, 'BusStackNameOutput', {
        value: exportPrefix,
        description: 'Name of the Bus stack for reference by other stacks',
        exportName: `${exportPrefix}-BusStackName`
    });
  }
} 