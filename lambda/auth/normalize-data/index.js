"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
// import { log } from '../../../leo-sdk/lib/streams'; // Commented out - needs refactoring
const { unmarshall, marshall } = require("@aws-sdk/util-dynamodb");
const config = require("leo-config");
const env = process.env.LEO_ENVIRONMENT;
const resourcesJson = JSON.parse(process.env.Resources);
config.bootstrap({ [env]: { leoaws: resourcesJson } });
const leoAws = require("leo-aws");
const dynamodb = leoAws.dynamodb;
const logger = require("leo-logger");
let AUTH_TABLE = config.leoaws.LeoAuth;
let IDENTITY_TABLE = config.leoaws.LeoAuthIdentity;
let POLICY_TABLE = config.leoaws.LeoAuthPolicy;
const handler = async (event) => {
    console.log(JSON.stringify(event, null, 2)); // Use console.log for now
    if (!event.Records || event.Records.length === 0) {
        return "No records found";
    }
    const record = event.Records[0]; //We limit to 1 event per call
    logger.log(record.eventSourceARN);
    try {
        if (record.eventSourceARN.match(POLICY_TABLE)) {
            logger.log(JSON.stringify(record, null, 2));
            const policy = unmarshall(record.dynamodb.NewImage);
            logger.log(JSON.stringify(policy, null, 2));
            const Items = await dynamodb.query({
                TableName: IDENTITY_TABLE,
                IndexName: "policy-identity-id",
                KeyConditionExpression: "policy = :policy",
                ExpressionAttributeValues: {
                    ":policy": policy.name
                }
            });
            logger.log("[Data]", Items);
            const ids = Items.reduce((sum, each) => {
                sum[each.identity] = true;
                return sum;
            }, {});
            logger.log("[ids]", ids);
            // Update all identities with default policies object
            await Promise.all(Object.keys(ids).map(async (id) => {
                logger.log("ID", id);
                await dynamodb.update({
                    TableName: AUTH_TABLE,
                    Key: {
                        identity: id
                    },
                    UpdateExpression: 'set #policies = if_not_exists(#policies, :policies)',
                    ExpressionAttributeNames: {
                        '#policies': "policies"
                    },
                    ExpressionAttributeValues: {
                        ':policies': {}
                    }
                });
            }));
            // Update all identities with policy statements
            await Promise.all(Items.map(async (identity) => {
                logger.log("Identity", identity.identity, policy.name, policy.statements);
                await dynamodb.update({
                    TableName: AUTH_TABLE,
                    Key: {
                        identity: identity.identity
                    },
                    UpdateExpression: 'set policies.#policy = :policy',
                    ExpressionAttributeNames: {
                        '#policy': policy.name
                    },
                    ExpressionAttributeValues: {
                        ':policy': policy.statements
                    }
                });
            }));
        }
        else {
            logger.log(JSON.stringify(record, null, 2));
            const keys = unmarshall(record.dynamodb.Keys);
            const Item = await dynamodb.get({
                TableName: AUTH_TABLE,
                Key: {
                    identity: keys.identity
                }
            });
            logger.log("Item", Item);
            let identity = Item || {
                identity: keys.identity,
                policies: {}
            };
            logger.log("in identity", identity);
            if (record.eventName == "REMOVE") {
                delete identity.policies[keys.policy.toLowerCase()];
                await saveIdentity(identity);
            }
            else {
                const { Item: policyItem } = await dynamodb.get({
                    TableName: POLICY_TABLE,
                    Key: {
                        name: keys.policy
                    }
                });
                if (policyItem) {
                    identity.policies[keys.policy.toLowerCase()] = policyItem.statements;
                }
                else {
                    identity.policies[keys.policy.toLowerCase()] = "";
                }
                await saveIdentity(identity);
            }
        }
        return "Success";
    }
    catch (error) {
        logger.error("Error:", error);
        throw error;
    }
};
exports.handler = handler;
async function saveIdentity(identity) {
    logger.log("out identity", identity);
    await dynamodb.put({
        TableName: AUTH_TABLE,
        Item: identity
    });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJpbmRleC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSwyRkFBMkY7QUFDM0YsTUFBTSxFQUFFLFVBQVUsRUFBRSxRQUFRLEVBQUUsR0FBRyxPQUFPLENBQUMsd0JBQXdCLENBQUMsQ0FBQztBQUNuRSxNQUFNLE1BQU0sR0FBRyxPQUFPLENBQUMsWUFBWSxDQUFDLENBQUM7QUFDckMsTUFBTSxHQUFHLEdBQUcsT0FBTyxDQUFDLEdBQUcsQ0FBQyxlQUF5QixDQUFBO0FBQ2pELE1BQU0sYUFBYSxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxTQUFtQixDQUFDLENBQUM7QUFDbEUsTUFBTSxDQUFDLFNBQVMsQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLEVBQUUsRUFBRSxNQUFNLEVBQUUsYUFBYSxFQUFFLEVBQUUsQ0FBQyxDQUFBO0FBQ3RELE1BQU0sTUFBTSxHQUFHLE9BQU8sQ0FBQyxTQUFTLENBQUMsQ0FBQztBQUNsQyxNQUFNLFFBQVEsR0FBRyxNQUFNLENBQUMsUUFBUSxDQUFDO0FBQ2pDLE1BQU0sTUFBTSxHQUFHLE9BQU8sQ0FBQyxZQUFZLENBQUMsQ0FBQztBQUVyQyxJQUFJLFVBQVUsR0FBRyxNQUFNLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQztBQUN2QyxJQUFJLGNBQWMsR0FBRyxNQUFNLENBQUMsTUFBTSxDQUFDLGVBQWUsQ0FBQztBQUNuRCxJQUFJLFlBQVksR0FBRyxNQUFNLENBQUMsTUFBTSxDQUFDLGFBQWEsQ0FBQztBQUt4QyxNQUFNLE9BQU8sR0FBRyxLQUFLLEVBQUUsS0FBVSxFQUFFLEVBQUU7SUFDMUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLEtBQUssRUFBRSxJQUFJLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLDBCQUEwQjtJQUN2RSxJQUFJLENBQUMsS0FBSyxDQUFDLE9B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QyxNQUFNO3FCQUNsQjtpQkFDRixDQUFDLENBQUM7Z0JBRUgsSUFBSSxVQUFVLEVBQUUsQ0FBQztvQkFDZixRQUFRLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsV0FBVyxFQUFFLENBQUMsR0FBRyxVQUFVLENBQUMsVUFBVSxDQUFDO2dCQUN2RSxDQUFDO3FCQUFNLENBQUM7b0JBQ04sUUFBUSxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLFdBQVcsRUFBRSxDQUFDLEdBQUcsRUFBRSxDQUFDO2dCQUNwRCxDQUFDO2dCQUVELE1BQU0sWUFBWSxDQUFDLFFBQVEsQ0FBQyxDQUFDO1lBQy9CLENBQUM7UUFDSCxDQUFDO1FBQ0QsT0FBTyxTQUFTLENBQUM7SUFDbkIsQ0FBQztJQUFDLE9BQU8sS0FBSyxFQUFFLENBQUM7UUFDZixNQUFNLENBQUMsS0FBSyxDQUFDLFFBQVEsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUM5QixNQUFNLEtBQUssQ0FBQztJQUNkLENBQUM7QUFDSCxDQUFDLENBQUE7QUFoSFksUUFBQSxPQUFPLFdBZ0huQjtBQUVELEtBQUssVUFBVSxZQUFZLENBQUMsUUFBa0I7SUFDNUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxjQUFjLEVBQUUsUUFBUSxDQUFDLENBQUM7SUFDckMsTUFBTSxRQUFRLENBQUMsR0FBRyxDQUFDO1FBQ2pCLFNBQVMsRUFBRSxVQUFVO1FBQ3JCLElBQUksRUFBRSxRQUFRO0tBQ2YsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIi8vIGltcG9ydCB7IGxvZyB9IGZyb20gJy4uLy4uLy4uL2xlby1zZGsvbGliL3N0cmVhbXMnOyAvLyBDb21tZW50ZWQgb3V0IC0gbmVlZHMgcmVmYWN0b3JpbmdcbmNvbnN0IHsgdW5tYXJzaGFsbCwgbWFyc2hhbGwgfSA9IHJlcXVpcmUoXCJAYXdzLXNkay91dGlsLWR5bmFtb2RiXCIpO1xuY29uc3QgY29uZmlnID0gcmVxdWlyZShcImxlby1jb25maWdcIik7XG5jb25zdCBlbnYgPSBwcm9jZXNzLmVudi5MRU9fRU5WSVJPTk1FTlQgYXMgc3RyaW5nXG5jb25zdCByZXNvdXJjZXNKc29uID0gSlNPTi5wYXJzZShwcm9jZXNzLmVudi5SZXNvdXJjZXMgYXMgc3RyaW5nKTtcbmNvbmZpZy5ib290c3RyYXAoeyBbZW52XTogeyBsZW9hd3M6IHJlc291cmNlc0pzb24gfSB9KVxuY29uc3QgbGVvQXdzID0gcmVxdWlyZShcImxlby1hd3NcIik7XG5jb25zdCBkeW5hbW9kYiA9IGxlb0F3cy5keW5hbW9kYjtcbmNvbnN0IGxvZ2dlciA9IHJlcXVpcmUoXCJsZW8tbG9nZ2VyXCIpO1xuXG5sZXQgQVVUSF9UQUJMRSA9IGNvbmZpZy5sZW9hd3MuTGVvQXV0aDtcbmxldCBJREVOVElUWV9UQUJMRSA9IGNvbmZpZy5sZW9hd3MuTGVvQXV0aElkZW50aXR5O1xubGV0IFBPTElDWV9UQUJMRSA9IGNvbmZpZy5sZW9hd3MuTGVvQXV0aFBvbGljeTtcblxuaW50ZXJmYWNlIEV2ZW50IHsgUmVjb3JkczogYW55W10gfVxuaW50ZXJmYWNlIElkZW50aXR5IHsgaWRlbnRpdHk/OiBhbnksIHBvbGljaWVzPzogYW55IH1cblxuZXhwb3J0IGNvbnN0IGhhbmRsZXIgPSBhc3luYyAoZXZlbnQ6IGFueSkgPT4ge1xuICBjb25zb2xlLmxvZyhKU09OLnN0cmluZ2lmeShldmVudCwgbnVsbCwgMikpOyAvLyBVc2UgY29uc29sZS5sb2cgZm9yIG5vd1xuICBpZiAoIWV2ZW50LlJlY29yZHMgfHwgZXZlbnQuUmVjb3Jkcy5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4gXCJObyByZWNvcmRzIGZvdW5kXCI7XG4gIH1cblxuICBjb25zdCByZWNvcmQgPSBldmVudC5SZWNvcmRzWzBdOyAvL1dlIGxpbWl0IHRvIDEgZXZlbnQgcGVyIGNhbGxcbiAgbG9nZ2VyLmxvZyhyZWNvcmQuZXZlbnRTb3VyY2VBUk4pO1xuXG4gIHRyeSB7XG4gICAgaWYgKHJlY29yZC5ldmVudFNvdXJjZUFSTi5tYXRjaChQT0xJQ1lfVEFCTEUpKSB7XG4gICAgICBsb2dnZXIubG9nKEpTT04uc3RyaW5naWZ5KHJlY29yZCwgbnVsbCwgMikpO1xuICAgICAgY29uc3QgcG9saWN5ID0gdW5tYXJzaGFsbChyZWNvcmQuZHluYW1vZGIuTmV3SW1hZ2UpO1xuICAgICAgbG9nZ2VyLmxvZyhKU09OLnN0cmluZ2lmeShwb2xpY3ksIG51bGwsIDIpKTtcblxuICAgICAgY29uc3QgSXRlbXMgPSBhd2FpdCBkeW5hbW9kYi5xdWVyeSh7XG4gICAgICAgIFRhYmxlTmFtZTogSURFTlRJVFlfVEFCTEUsXG4gICAgICAgIEluZGV4TmFtZTogXCJwb2xpY3ktaWRlbnRpdHktaWRcIixcbiAgICAgICAgS2V5Q29uZGl0aW9uRXhwcmVzc2lvbjogXCJwb2xpY3kgPSA6cG9saWN5XCIsXG4gICAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVWYWx1ZXM6IHtcbiAgICAgICAgICBcIjpwb2xpY3lcIjogcG9saWN5Lm5hbWVcbiAgICAgICAgfVxuICAgICAgfSk7XG5cbiAgICAgIGxvZ2dlci5sb2coXCJbRGF0YV1cIiwgSXRlbXMpO1xuXG4gICAgICBjb25zdCBpZHMgPSBJdGVtcy5yZWR1Y2UoKHN1bTogYW55LCBlYWNoOiBhbnkpID0+IHtcbiAgICAgICAgc3VtW2VhY2guaWRlbnRpdHldID0gdHJ1ZTtcbiAgICAgICAgcmV0dXJuIHN1bTtcbiAgICAgIH0sIHt9KTtcblxuICAgICAgbG9nZ2VyLmxvZyhcIltpZHNdXCIsIGlkcyk7XG5cbiAgICAgIC8vIFVwZGF0ZSBhbGwgaWRlbnRpdGllcyB3aXRoIGRlZmF1bHQgcG9saWNpZXMgb2JqZWN0XG4gICAgICBhd2FpdCBQcm9taXNlLmFsbChPYmplY3Qua2V5cyhpZHMpLm1hcChhc3luYyAoaWQpID0+IHtcbiAgICAgICAgbG9nZ2VyLmxvZyhcIklEXCIsIGlkKTtcbiAgICAgICAgYXdhaXQgZHluYW1vZGIudXBkYXRlKHtcbiAgICAgICAgICBUYWJsZU5hbWU6IEFVVEhfVEFCTEUsXG4gICAgICAgICAgS2V5OiB7XG4gICAgICAgICAgICBpZGVudGl0eTogaWRcbiAgICAgICAgICB9LFxuICAgICAgICAgIFVwZGF0ZUV4cHJlc3Npb246ICdzZXQgI3BvbGljaWVzID0gaWZfbm90X2V4aXN0cygjcG9saWNpZXMsIDpwb2xpY2llcyknLFxuICAgICAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczoge1xuICAgICAgICAgICAgJyNwb2xpY2llcyc6IFwicG9saWNpZXNcIlxuICAgICAgICAgIH0sXG4gICAgICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgICAgICAgJzpwb2xpY2llcyc6IHt9XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgIH0pKTtcblxuICAgICAgLy8gVXBkYXRlIGFsbCBpZGVudGl0aWVzIHdpdGggcG9saWN5IHN0YXRlbWVudHNcbiAgICAgIGF3YWl0IFByb21pc2UuYWxsKEl0ZW1zLm1hcChhc3luYyAoaWRlbnRpdHk6YW55KSA9PiB7XG4gICAgICAgIGxvZ2dlci5sb2coXCJJZGVudGl0eVwiLCBpZGVudGl0eS5pZGVudGl0eSwgcG9saWN5Lm5hbWUsIHBvbGljeS5zdGF0ZW1lbnRzKTtcbiAgICAgICAgYXdhaXQgZHluYW1vZGIudXBkYXRlKHtcbiAgICAgICAgICBUYWJsZU5hbWU6IEFVVEhfVEFCTEUsXG4gICAgICAgICAgS2V5OiB7XG4gICAgICAgICAgICBpZGVudGl0eTogaWRlbnRpdHkuaWRlbnRpdHlcbiAgICAgICAgICB9LFxuICAgICAgICAgIFVwZGF0ZUV4cHJlc3Npb246ICdzZXQgcG9saWNpZXMuI3BvbGljeSA9IDpwb2xpY3knLFxuICAgICAgICAgIEV4cHJlc3Npb25BdHRyaWJ1dGVOYW1lczoge1xuICAgICAgICAgICAgJyNwb2xpY3knOiBwb2xpY3kubmFtZVxuICAgICAgICAgIH0sXG4gICAgICAgICAgRXhwcmVzc2lvbkF0dHJpYnV0ZVZhbHVlczoge1xuICAgICAgICAgICAgJzpwb2xpY3knOiBwb2xpY3kuc3RhdGVtZW50c1xuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG4gICAgICB9KSk7XG5cbiAgICB9IGVsc2Uge1xuICAgICAgbG9nZ2VyLmxvZyhKU09OLnN0cmluZ2lmeShyZWNvcmQsIG51bGwsIDIpKTtcbiAgICAgIGNvbnN0IGtleXMgPSB1bm1hcnNoYWxsKHJlY29yZC5keW5hbW9kYi5LZXlzKTtcbiAgICAgIGNvbnN0IEl0ZW0gPSBhd2FpdCBkeW5hbW9kYi5nZXQoe1xuICAgICAgICBUYWJsZU5hbWU6IEFVVEhfVEFCTEUsXG4gICAgICAgIEtleToge1xuICAgICAgICAgIGlkZW50aXR5OiBrZXlzLmlkZW50aXR5XG4gICAgICAgIH1cbiAgICAgIH0pO1xuICAgICAgbG9nZ2VyLmxvZyhcIkl0ZW1cIiwgSXRlbSk7XG5cbiAgICAgIGxldCBpZGVudGl0eTogSWRlbnRpdHkgPSBJdGVtIHx8IHtcbiAgICAgICAgaWRlbnRpdHk6IGtleXMuaWRlbnRpdHksXG4gICAgICAgIHBvbGljaWVzOiB7fVxuICAgICAgfTtcblxuICAgICAgbG9nZ2VyLmxvZyhcImluIGlkZW50aXR5XCIsIGlkZW50aXR5KTtcblxuICAgICAgaWYgKHJlY29yZC5ldmVudE5hbWUgPT0gXCJSRU1PVkVcIikge1xuICAgICAgICBkZWxldGUgaWRlbnRpdHkucG9saWNpZXNba2V5cy5wb2xpY3kudG9Mb3dlckNhc2UoKV07XG4gICAgICAgIGF3YWl0IHNhdmVJZGVudGl0eShpZGVudGl0eSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBjb25zdCB7IEl0ZW06IHBvbGljeUl0ZW0gfSA9IGF3YWl0IGR5bmFtb2RiLmdldCh7XG4gICAgICAgICAgVGFibGVOYW1lOiBQT0xJQ1lfVEFCTEUsXG4gICAgICAgICAgS2V5OiB7XG4gICAgICAgICAgICBuYW1lOiBrZXlzLnBvbGljeVxuICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgaWYgKHBvbGljeUl0ZW0pIHtcbiAgICAgICAgICBpZGVudGl0eS5wb2xpY2llc1trZXlzLnBvbGljeS50b0xvd2VyQ2FzZSgpXSA9IHBvbGljeUl0ZW0uc3RhdGVtZW50cztcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBpZGVudGl0eS5wb2xpY2llc1trZXlzLnBvbGljeS50b0xvd2VyQ2FzZSgpXSA9IFwiXCI7XG4gICAgICAgIH1cblxuICAgICAgICBhd2FpdCBzYXZlSWRlbnRpdHkoaWRlbnRpdHkpO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gXCJTdWNjZXNzXCI7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgbG9nZ2VyLmVycm9yKFwiRXJyb3I6XCIsIGVycm9yKTtcbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxufVxuXG5hc3luYyBmdW5jdGlvbiBzYXZlSWRlbnRpdHkoaWRlbnRpdHk6IElkZW50aXR5KSB7XG4gIGxvZ2dlci5sb2coXCJvdXQgaWRlbnRpdHlcIiwgaWRlbnRpdHkpO1xuICBhd2FpdCBkeW5hbW9kYi5wdXQoe1xuICAgIFRhYmxlTmFtZTogQVVUSF9UQUJMRSxcbiAgICBJdGVtOiBpZGVudGl0eVxuICB9KTtcbn0iXX0=