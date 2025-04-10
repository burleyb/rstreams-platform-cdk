import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

// Import new constructs
import { Auth } from './auth/auth-stack';
import { Bus } from './bus/bus-stack';
import { Botmon } from './botmon/botmon-stack';

export interface RStreamsPlatformStackProps extends cdk.StackProps {
  /**
   * The environment for the deployment (dev, staging, prod, etc.)
   * Should be passed via context `-c environment=dev` or defined in cdk.json
   * @default 'dev'
   */
  environmentName?: string;
}

export interface BusProps {
  environmentName: string;
  trustedArns?: string[];
  queueReplicationDestinations?: string[];
  queueReplicationMapping?: string;
  lambdaInvokePolicy?: string;
  kinesisShards?: number;
  lambdaMemory?: {
    kinesisStreamProcessor?: number;
    firehoseStreamProcessor?: number;
    cronProcessor?: number;
    eventTrigger?: number;
    monitor?: number;
  };
  streamTTLSeconds?: number;
  monitorShardHashKey?: number;
  exportNamePrefix?: string;
}

export class RStreamsPlatformStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: RStreamsPlatformStackProps) {
    super(scope, id, props);

    // Set up the environment context from CDK context or props
    const environmentName = this.node.tryGetContext('environment') || props?.environmentName || 'dev';
    
    // Get the NodejsFunction configuration from app context
    const nodejsFunctionProps = this.node.tryGetContext('nodeJsFunctionProps');
    if (!nodejsFunctionProps) {
      throw new Error('NodejsFunction configuration is required in app context. Please set nodeJsFunctionProps in the CDK app.');
    }

    // Instantiate new Auth construct
    const auth = new Auth(this, 'Auth', {
      environmentName: environmentName,
    });

    // Get trusted AWS principals for cross-account access
    const trustedArns = this.node.tryGetContext('trustedAWSPrinciples') ? 
      this.node.tryGetContext('trustedAWSPrinciples').split(',') : 
      undefined;

    // Get queue replication destinations for cross-account replication
    const queueReplicationDestinations = this.node.tryGetContext('queueReplicationDestinationLeoBotRoleARNs') ?
      this.node.tryGetContext('queueReplicationDestinationLeoBotRoleARNs').split(',') :
      undefined;

    // Get queue replication mapping configuration
    const queueReplicationMapping = this.node.tryGetContext('queueReplicationMapping') || '[]';

    // Detect LocalStack environment
    const isLocalStack = this.account === '000000000000' || 
                         this.region === 'local' ||
                         process.env.LOCALSTACK_HOSTNAME !== undefined ||
                         process.env.CDK_LOCAL === 'true';
    
    console.log(`STACK: Detected environment: account=${this.account}, region=${this.region}, isLocalStack=${isLocalStack}`);

    // Instantiate new Bus construct with all parameters from original CloudFormation
    const bus = new Bus(this, 'Bus', {
      environmentName: environmentName,
      trustedArns: trustedArns,
      queueReplicationDestinations: queueReplicationDestinations,
      queueReplicationMapping: queueReplicationMapping,
      lambdaMemory: {
        kinesisStreamProcessor: this.node.tryGetContext('kinesisStreamProcessorMemory') || 640,
        firehoseStreamProcessor: this.node.tryGetContext('firehoseStreamProcessorMemory') || 640,
        cronProcessor: this.node.tryGetContext('cronProcessorMemory') || 256,
        eventTrigger: this.node.tryGetContext('eventTriggerMemory') || 128,
        monitor: this.node.tryGetContext('leoMonitorMemory') || 256
      },
      exportNamePrefix: this.stackName,
      lambdaInvokePolicy: this.node.tryGetContext('lambdaInvokePolicy'),
      kinesisShards: this.node.tryGetContext('kinesisShards') || 1,
      streamTTLSeconds: this.node.tryGetContext('streamTTLSeconds') || 604800,
      monitorShardHashKey: this.node.tryGetContext('monitorShardHashKey') || 0,
      // Skip Firehose resource for LocalStack
      skipForLocalStack: isLocalStack ? { firehose: true } : undefined
    });

    // Get custom JS and logins for Botmon UI customization
    const customJs = this.node.tryGetContext('customJs');
    const logins = this.node.tryGetContext('logins');

    // Get existing Cognito ID if provided
    const inputCognitoId = this.node.tryGetContext('inputCognitoId');
    const createCognito = !inputCognitoId;

    // Instantiate new Botmon construct with Cognito configuration
    const botmon = new Botmon(this, 'Botmon', {
      environmentName: environmentName,
      bus: bus,
      auth: auth,
      customJs: customJs,
      logins: logins,
      createCognito: createCognito,
      existingCognitoId: inputCognitoId
    });

    // Create the SSM parameter using output from Bus construct
    const rsfParameter = new ssm.StringParameter(this, 'RStreamsPlatformRSFParameter', {
      parameterName: this.stackName,
      stringValue: bus.busStackNameOutput,
      description: 'RStreams Bus Stack Reference Name'
    });

    // Create a secret in Secrets Manager with table names and other references
    const secretValue = cdk.Fn.join('', [
      '{',
      '"LeoStream":"', bus.leoStreamTable.tableName, '",',
      '"LeoCron":"', bus.leoCronTable.tableName, '",',
      '"LeoEvent":"', bus.leoEventTable.tableName, '",',
      '"LeoSettings":"', bus.leoSettingsTable.tableName, '",',
      '"LeoSystem":"', bus.leoSystemTable.tableName, '",',
      '"LeoKinesisStream":"', bus.leoKinesisStream.streamName, '",',
      '"LeoFirehoseStream":"', bus.leoFirehoseStreamName, '",',
      '"LeoS3":"', bus.leoS3Bucket.bucketName, '",',
      '"Region":"', this.region, '"',
      '}'
    ]);

    const platformSecret = new secretsmanager.Secret(this, 'RStreamsPlatformSecret', {
      secretName: `rstreams-${this.stackName}`,
      description: 'RStreams Platform resource references',
      secretStringValue: cdk.SecretValue.unsafePlainText(secretValue.toString())
    });

    // CloudFront URL for Botmon UI access
    new cdk.CfnOutput(this, 'BotmonURL', {
      description: 'Botmon UI URL',
      value: `https://${botmon.cloudfrontDistribution.distributionDomainName}`
    });

    // Add output for the Secret ARN
    new cdk.CfnOutput(this, 'PlatformSecretARN', {
      description: 'ARN of the RStreams Platform Secret',
      value: platformSecret.secretArn
    });

    // Create ApiRole for Lambda function invocation
    const apiRole = new iam.Role(this, 'ApiRole', {
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal('lambda.amazonaws.com'),
        new iam.AccountPrincipal(this.account)
      ),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
      ]
    });

    apiRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:AddPermission'],
      resources: ['*']
    }));

    apiRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [cdk.Fn.sub('arn:aws:lambda:${AWS::Region}:${AWS::AccountId}:function:${AWS::StackName}-*')]
    }));
  }
}
