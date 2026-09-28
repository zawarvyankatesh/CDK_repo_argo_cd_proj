#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { TaskboardCiStack } from '../lib/aws_codebuild_ecr_cdk-stack';

const app = new cdk.App();

new TaskboardCiStack(app, 'TaskboardCiStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description: 'CodeBuild CI and three ECR repositories for Orbit Taskboard',
});