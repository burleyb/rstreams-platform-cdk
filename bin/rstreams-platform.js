#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("source-map-support/register");
const cdk = require("aws-cdk-lib");
const rstreams_platform_stack_1 = require("../lib/rstreams-platform-stack");
const app = new cdk.App();
new rstreams_platform_stack_1.RStreamsPlatformStack(app, 'RStreamsPlatformStack', {
    /* If you don't specify 'env', this stack will be environment-agnostic. */
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION
    },
    description: 'RStreams Platform Stack',
    environmentName: app.node.tryGetContext('environment') || 'dev', // Use environmentName and a default like 'dev'
});
app.synth();
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicnN0cmVhbXMtcGxhdGZvcm0uanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJyc3RyZWFtcy1wbGF0Zm9ybS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFDQSx1Q0FBcUM7QUFDckMsbUNBQW1DO0FBQ25DLDRFQUF1RTtBQUV2RSxNQUFNLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztBQUMxQixJQUFJLCtDQUFxQixDQUFDLEdBQUcsRUFBRSx1QkFBdUIsRUFBRTtJQUN0RCwwRUFBMEU7SUFDMUUsR0FBRyxFQUFFO1FBQ0gsT0FBTyxFQUFFLE9BQU8sQ0FBQyxHQUFHLENBQUMsbUJBQW1CO1FBQ3hDLE1BQU0sRUFBRSxPQUFPLENBQUMsR0FBRyxDQUFDLGtCQUFrQjtLQUN2QztJQUNELFdBQVcsRUFBRSx5QkFBeUI7SUFDdEMsZUFBZSxFQUFFLEdBQUcsQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLGFBQWEsQ0FBQyxJQUFJLEtBQUssRUFBRSwrQ0FBK0M7Q0FDakgsQ0FBQyxDQUFDO0FBRUgsR0FBRyxDQUFDLEtBQUssRUFBRSxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiIyEvdXNyL2Jpbi9lbnYgbm9kZVxuaW1wb3J0ICdzb3VyY2UtbWFwLXN1cHBvcnQvcmVnaXN0ZXInO1xuaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCB7IFJTdHJlYW1zUGxhdGZvcm1TdGFjayB9IGZyb20gJy4uL2xpYi9yc3RyZWFtcy1wbGF0Zm9ybS1zdGFjayc7XG5cbmNvbnN0IGFwcCA9IG5ldyBjZGsuQXBwKCk7XG5uZXcgUlN0cmVhbXNQbGF0Zm9ybVN0YWNrKGFwcCwgJ1JTdHJlYW1zUGxhdGZvcm1TdGFjaycsIHtcbiAgLyogSWYgeW91IGRvbid0IHNwZWNpZnkgJ2VudicsIHRoaXMgc3RhY2sgd2lsbCBiZSBlbnZpcm9ubWVudC1hZ25vc3RpYy4gKi9cbiAgZW52OiB7XG4gICAgYWNjb3VudDogcHJvY2Vzcy5lbnYuQ0RLX0RFRkFVTFRfQUNDT1VOVCxcbiAgICByZWdpb246IHByb2Nlc3MuZW52LkNES19ERUZBVUxUX1JFR0lPTlxuICB9LFxuICBkZXNjcmlwdGlvbjogJ1JTdHJlYW1zIFBsYXRmb3JtIFN0YWNrJyxcbiAgZW52aXJvbm1lbnROYW1lOiBhcHAubm9kZS50cnlHZXRDb250ZXh0KCdlbnZpcm9ubWVudCcpIHx8ICdkZXYnLCAvLyBVc2UgZW52aXJvbm1lbnROYW1lIGFuZCBhIGRlZmF1bHQgbGlrZSAnZGV2J1xufSk7XG5cbmFwcC5zeW50aCgpO1xuIl19