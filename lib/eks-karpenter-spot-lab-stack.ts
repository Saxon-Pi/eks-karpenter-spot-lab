/*
# Karpenter + Spot を使用した EKS Cluster 構成

├─ Managed Node Group (On-Demand)
│  NodeGroup Name: system-ng
│
│  役割:
│   ├─ Karpenter Controller
│   ├─ CoreDNS
│   ├─ aws-node
│   ├─ kube-proxy
│   └─ 将来的な監視Pod
│
└─ Karpenter 管理下 Node
   NodePool: spot-workload
   Capacity Type: Spot
   作成タイミング:
     └─ Pending Pod が発生したとき
   削除タイミング:
     └─ 不要になったとき / Consolidation対象になったとき

   ├─ Spot Node ← アプリケーションPod
   ├─ Spot Node ← アプリケーションPod
   └─ Spot Node ← アプリケーションPod


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
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';

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

      // Access Entry を明示追加
      authenticationMode: eks.AuthenticationMode.API_AND_CONFIG_MAP,
      bootstrapClusterCreatorAdminPermissions: true,
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

    // =====================================================
    // Karpenter IAM / Interruption Handling
    // =====================================================

    // Karpenter 公式が推奨する EventBridge Rules と SQS を使った
    // interruption events を Karpenter Controller へ渡す構成

    const clusterName = cluster.clusterName;

    // Karpenter が作成する EC2 Node に付与する Role
    const karpenterNodeRole = new iam.Role(this, 'KarpenterNodeRole', {
      roleName: `KarpenterNodeRole-${clusterName}`,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });

    karpenterNodeRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKSWorkerNodePolicy'),
    );
    karpenterNodeRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEKS_CNI_Policy'),
    );
    karpenterNodeRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
    );
    karpenterNodeRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
    );

    // Karpenter の Spot / Rebalance / EC2 状態変化イベント受信用 Queue
    const interruptionQueue = new sqs.Queue(this, 'KarpenterInterruptionQueue', {
      queueName: `${clusterName}-karpenter-interruption`,
      retentionPeriod: cdk.Duration.minutes(5),
    });

    // SQS が EventBridge からメッセージを受け取れるようにする
    interruptionQueue.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('events.amazonaws.com')],
        actions: ['sqs:SendMessage'],
        resources: [interruptionQueue.queueArn],
      }),
    );

    // EventBridge: Spot Interruption Warning
    new events.Rule(this, 'SpotInterruptionRule', {
      eventPattern: {
        source: ['aws.ec2'],
        detailType: ['EC2 Spot Instance Interruption Warning'],
      },
      targets: [new targets.SqsQueue(interruptionQueue)],
    });

    // EventBridge: Rebalance Recommendation
    new events.Rule(this, 'RebalanceRecommendationRule', {
      eventPattern: {
        source: ['aws.ec2'],
        detailType: ['EC2 Instance Rebalance Recommendation'],
      },
      targets: [new targets.SqsQueue(interruptionQueue)],
    });

    // EventBridge: Instance State-change
    new events.Rule(this, 'InstanceStateChangeRule', {
      eventPattern: {
        source: ['aws.ec2'],
        detailType: ['EC2 Instance State-change Notification'],
      },
      targets: [new targets.SqsQueue(interruptionQueue)],
    });

    // EventBridge: AWS Health Event
    new events.Rule(this, 'HealthEventRule', {
      eventPattern: {
        source: ['aws.health'],
        detailType: ['AWS Health Event'],
      },
      targets: [new targets.SqsQueue(interruptionQueue)],
    });

    // =====================================================
    // EKS Access Entry
    // =====================================================

    // CDK 実行時に外から渡す IAM User / Role の ARN
    const adminPrincipalArn = this.node.tryGetContext('adminPrincipalArn');
    
    // EKS Cluster に対する kubectl 管理権限を付与
    // (public repository のため ARN はコードへ直接記載しない)
    if (adminPrincipalArn) {
      new eks.CfnAccessEntry(this, 'AdminAccessEntry', {
        clusterName: cluster.clusterName,
        principalArn: adminPrincipalArn,
        type: 'STANDARD',
        accessPolicies: [
          {
            policyArn: 'arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy',
            accessScope: {
              type: 'cluster',
            },
          },
        ],
      });
    }

  }
}
