# EKS Karpenter Spot Lab

## 概要

本プロジェクトは Amazon EKS 上で Karpenter を利用し、以下を検証する  

- Node 自動プロビジョニング
- Spot Instance 活用
- Node 最適化
- コスト最適化
- Interruption Handling

従来の Managed Node Group + Node Termination Handler 構成とは異なり、  
Karpenter を利用することで Kubernetes ワークロードの要求に応じた Node の自動作成・削除を実現する  

また、Spot Instance を活用しながら、高可用性を維持する構成を検証することを目的とする  

## 検証機能

Karpenter

- NodePool
- EC2NodeClass
- Node Lifecycle Management
- Consolidation
- Drift
- Interruption Handling

Kubernetes

- Pod Scheduling
- Resource Requests / Limits
- NodeSelector
- Taints / Tolerations
- Affinity
- Topology Spread Constraints
- Pod Disruption Budget

AWS

- Amazon EKS
- EC2 Spot Instances
- EventBridge
- SQS
- IAM Roles for Service Accounts (IRSA)
- CloudWatch Logs

## アーキテクチャ

```text
Pending Pod
↓
Kubernetes Scheduler
↓
Karpenter
↓
EC2 Fleet API
↓
Spot Node Provisioning
↓
Pod Scheduling
```

## Spot Interruption

```text
Spot Interruption
Rebalance Recommendation
Scheduled Maintenance
↓
EventBridge
↓
SQS
↓
Karpenter
↓
Node Drain
↓
Pod Re-Scheduling
↓
New Spot Node
```

## 検証項目

1. Dynamic Node Provisioning

Pod 作成時に Node が自動生成されることを確認

2. Dynamic Node Consolidation

不要 Node が自動削除されることを確認

3. Spot Node Provisioning

Spot Node が自動選択されることを確認

4. Topology Spread Constraints

Pod が Node 間に分散配置されることを確認

5. Pod Disruption Budget

Node 中断時でも最低稼働台数が維持されることを確認

6. Interruption Handling

Spot 終了イベントおよび Rebalance Recommendation を検知し、  
Pod が Graceful Shutdown できることを確認

## プロジェクトゴール

- Karpenter の仕組みを理解する
- EKS の Node Lifecycle を理解する
- Spot Instance 運用を理解する
- コスト最適化パターンを学習する
- 実務レベルで Karpenter を運用できる知識を身につける
