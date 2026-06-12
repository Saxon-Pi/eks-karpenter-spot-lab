/*
# Karpenter + Spot を使用した EKS Cluster 構成

├─ Managed Node Group (On-Demand)
│  NodeGroup Name: system-ng
│   ├─ Karpenter Controller
│   ├─ aws-node
│   ├─ kube-proxy
│   ├─ coredns
│   └─ 将来的な監視Pod
│
└─ Karpenter 管理下 Node (自動生成)
    ├─ Spot Node ← アプリケーションはこっちにデプロイ
    ├─ Spot Node
    └─ Spot Node

# Managed Node Group と Karpenter の違い
Managed Node Group: ASG / NodeGroup 単位で Node を管理

Karpenter: NodePool の条件に合う EC2 Node を直接プロビジョニング

NodePool
└─ Pod 要求に合うSpot Nodeを都度作る
   ├─ m5.large
   ├─ c6i.large
   ├─ r6i.xlarge
   └─ ...
*/


import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as eks from 'aws-cdk-lib/aws-eks';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { KubectlV31Layer } from '@aws-cdk/lambda-layer-kubectl-v31';

export class EksKarpenterSpotLabStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // =====================================================
    // VPC
    // =====================================================

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 1,
    });

    // =====================================================
    // EKS Cluster
    // =====================================================

    const cluster = new eks.Cluster(this, 'Cluster', {
      clusterName: 'eks-karpenter-spot-lab',
      version: eks.KubernetesVersion.V1_31,
      vpc,
      defaultCapacity: 0,
      endpointAccess: eks.EndpointAccess.PUBLIC_AND_PRIVATE,
      kubectlLayer: new KubectlV31Layer(this, 'KubectlLayer'),
    });

    // =====================================================
    // Managed NodeGroup for system / Karpenter controller
    // =====================================================
    
    // クラスター管理のための NodeGroup
    cluster.addNodegroupCapacity('SystemNodeGroup', {
      nodegroupName: 'system-ng',
      instanceTypes: [new ec2.InstanceType('t3.medium')],
      minSize: 1,
      desiredSize: 1,
      maxSize: 1,
      labels: {
        'workload-type': 'system',
        'node-lifecycle': 'on-demand',
      },
      // アプリを system Node に載せない
      taints: [
        {
          key: 'system',
          value: 'true',
          effect: eks.TaintEffect.NO_SCHEDULE,
        },
      ],
    });

    // =====================================================
    // ECR
    // =====================================================

    new ecr.Repository(this, 'AppRepository', {
      repositoryName: 'karpenter-test-app',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });
  }
}
