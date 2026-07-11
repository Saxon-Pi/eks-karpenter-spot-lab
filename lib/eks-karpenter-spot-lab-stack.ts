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

    const clusterName = 'eks-karpenter-spot-lab';

    const cluster = new eks.Cluster(this, 'Cluster', {
      clusterName,
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
    // Karpenter Discovery Tags
    // =====================================================

    // Karpenter が Node を起動する Private Subnet を探索するためのタグ
    for (const subnet of vpc.privateSubnets) {
      cdk.Tags.of(subnet).add(
        'karpenter.sh/discovery',
        clusterName,
      );
    }

    // Karpenter が Node に付与する Security Group を探索するためのタグ
    cdk.Tags.of(cluster.clusterSecurityGroup).add(
      'karpenter.sh/discovery',
      clusterName,
    );
    
    // 上記でタグがつかない場合は手動で付与
    // aws ec2 create-tags \
    //   --profile <profile> \
    //   --region <region> \
    //   --resources sg-xxx \
    //   --tags Key=karpenter.sh/discovery,Value=eks-karpenter-spot-lab

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
      // Karpenter には toleration を付けたが、CoreDNS には付けておらず、
      // Karpenter Pod は起動しても、DNS 解決できず STS へ到達できない問題が起きたため一旦無効
      // Karpenter が起動してから、system node を隔離する設計に戻す
      // アプリを system Node に載せない
      // taints: [
      //   {
      //     key: 'system',
      //     value: 'true',
      //     effect: eks.TaintEffect.NO_SCHEDULE,
      //   },
      // ],
    });

    // =====================================================
    // Karpenter Namespace
    // =====================================================

    const karpenterNamespace = cluster.addManifest('KarpenterNamespace', {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name: 'karpenter',
      },
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

    // karpenterNodeInstanceProfile: Karpenter が作成した Node 自身の権限
    // EC2インスタンスには Instance Profile 経由で IAM Role を紐づける
    const karpenterNodeInstanceProfile = new iam.CfnInstanceProfile(
      this,
      'KarpenterNodeInstanceProfile',
      {
        instanceProfileName: `KarpenterNodeInstanceProfile-${clusterName}`,
        roles: [karpenterNodeRole.roleName],
      },
    );

    // karpenterServiceAccount: Karpenter Controller (Pod) 自身の権限
    // Pod には ServiceAccount 経由で IAM Role を紐づける
    const karpenterServiceAccount = cluster.addServiceAccount('KarpenterServiceAccount', {
      name: 'karpenter',
      namespace: 'karpenter',
    });

    karpenterServiceAccount.node.addDependency(karpenterNamespace);

    karpenterServiceAccount.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'ec2:CreateFleet',
          'ec2:CreateLaunchTemplate',
          'ec2:CreateTags',
          'ec2:DeleteLaunchTemplate',
          'ec2:DescribeAvailabilityZones',
          'ec2:DescribeImages',
          'ec2:DescribeInstances',
          'ec2:DescribeInstanceTypeOfferings',
          'ec2:DescribeInstanceTypes',
          'ec2:DescribeLaunchTemplates',
          'ec2:DescribeSecurityGroups',
          'ec2:DescribeSpotPriceHistory',
          'ec2:DescribeSubnets',
          'ec2:RunInstances',
          'ec2:TerminateInstances',
          'pricing:GetProducts',
          'ssm:GetParameter',
          'eks:DescribeCluster',
          'iam:GetInstanceProfile',
          'iam:CreateInstanceProfile',
          'iam:DeleteInstanceProfile',
          'iam:AddRoleToInstanceProfile',
          'iam:RemoveRoleFromInstanceProfile',
          'iam:TagInstanceProfile',
        ],
        resources: ['*'],
      }),
    );

    karpenterServiceAccount.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [karpenterNodeRole.roleArn],
      }),
    );

    // Karpenter の Spot / Rebalance / EC2 状態変化イベント受信用 Queue
    const interruptionQueue = new sqs.Queue(this, 'KarpenterInterruptionQueue', {
      queueName: `${clusterName}-karpenter-interruption`,
      retentionPeriod: cdk.Duration.minutes(5),
    });

    karpenterServiceAccount.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'sqs:DeleteMessage',
          'sqs:GetQueueAttributes',
          'sqs:GetQueueUrl',
          'sqs:ReceiveMessage',
        ],
        resources: [interruptionQueue.queueArn],
      }),
    );

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
      const adminAccessEntry = new eks.CfnAccessEntry(this, 'AdminAccessEntry', {
        clusterName,
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

      adminAccessEntry.node.addDependency(cluster);
    }

    // Karpenter Node Role 用 Access Entry
    // Karpenter が作成した Node が EKS Cluster に登録できるようにする
    const karpenterNodeAccessEntry = new eks.CfnAccessEntry(this, 'KarpenterNodeAccessEntry', {
      clusterName,
      principalArn: karpenterNodeRole.roleArn,
      type: 'EC2_LINUX',
    });

    karpenterNodeAccessEntry.node.addDependency(cluster);

    // =====================================================
    // AWS Load Balancer Controller IAM
    // =====================================================

    const albControllerServiceAccount = cluster.addServiceAccount(
      'AwsLoadBalancerControllerServiceAccount',
      {
        name: 'aws-load-balancer-controller',
        namespace: 'kube-system',
      },
    );

    // 検証用のため、広めに権限付与
    // 本番では公式 iam_policy.json 相当へ絞る
    albControllerServiceAccount.role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          'iam:CreateServiceLinkedRole',

          'ec2:DescribeAccountAttributes',
          'ec2:DescribeAddresses',
          'ec2:DescribeAvailabilityZones',
          'ec2:DescribeInternetGateways',
          'ec2:DescribeVpcs',
          'ec2:DescribeVpcPeeringConnections',
          'ec2:DescribeSubnets',
          'ec2:DescribeSecurityGroups',
          'ec2:DescribeInstances',
          'ec2:DescribeNetworkInterfaces',
          'ec2:DescribeTags',
          'ec2:DescribeRouteTables',
          'ec2:GetSecurityGroupsForVpc',

          'ec2:CreateSecurityGroup',
          'ec2:CreateTags',
          'ec2:DeleteTags',
          'ec2:AuthorizeSecurityGroupIngress',
          'ec2:RevokeSecurityGroupIngress',
          'ec2:DeleteSecurityGroup',

          'elasticloadbalancing:*',

          'acm:ListCertificates',
          'acm:DescribeCertificate',
          'iam:ListServerCertificates',
          'iam:GetServerCertificate',
          'waf-regional:*',
          'wafv2:*',
          'shield:*',
          'cognito-idp:DescribeUserPoolClient',
        ],
        resources: ['*'],
      }),
    );

    // =====================================================
    // Argo CD
    // =====================================================

    const argoCdChart = cluster.addHelmChart('ArgoCd', {
      chart: 'argo-cd',
      repository: 'https://argoproj.github.io/argo-helm',
      namespace: 'argocd',
      createNamespace: true,

      // 再現性のため、動作確認したChart versionを固定する
      // version: 'x.y.z',

      values: {
        server: {
          service: {
            type: 'ClusterIP',
          },
        },
      },
    });


  }
}
