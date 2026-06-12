#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EksKarpenterSpotLabStack } from '../lib/eks-karpenter-spot-lab-stack';

const app = new cdk.App();

new EksKarpenterSpotLabStack(app, 'EksKarpenterSpotLabStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
