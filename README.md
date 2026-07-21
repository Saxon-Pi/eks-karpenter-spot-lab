# Amazon EKS × Karpenter 技術検証

## 概要

Amazon EKS を題材に **Kubernetes の内部動作を理解すること** を目的として、  
段階的な技術検証を実施した

単に EKS クラスターを構築するだけではなく、

- なぜ Pod がその Node に配置されるのか
- kube-system の各コンポーネントは何をしているのか
- Ingress はどのように ALB を作成するのか
- GitOps では Git の変更がどのように反映されるのか

など、実際に動作を確認しながら理解を深めた

---

# 検証環境

- Amazon EKS
- AWS CDK (TypeScript)
- Karpenter
- Argo CD
- AWS Load Balancer Controller
- NGINX

---

# 学習ロードマップ

## ① Karpenter と NodeGroup の違い

Karpenter の役割や Managed NodeGroup との違いを整理し、  
Pod が Pending になってから Node が作成されるまでの流れを理解した

### 学んだこと

- NodeGroup と Karpenter の役割の違い
- NodePool / EC2NodeClass の構成
- Karpenter が Node を起動するタイミング
- Cluster Autoscaler との違い

📄 詳細は以下

- [01_KarpenterとNodeGroupの違い.md](docs/01_KarpenterとNodeGroupの違い.md)

---

## ② Request CPU / Memory の検証

Deployment の Request CPU / Memory を変更し、  
Kubernetes Scheduler と Karpenter の動作を確認した

### 学んだこと

- Scheduler が Request を利用して配置を判断する仕組み
- Request と Limit の違い
- Pending Pod 発生時の Karpenter の動作
- 適切な Request 設計の重要性

📄 詳細は以下

- [02_Requestサイズ検証.md](docs/02_Requestサイズ検証.md)

---

## ③ kube-system の理解

EKS クラスター起動時に作成されるシステム Pod の役割を調査した

### 学んだこと

- CoreDNS
- aws-node (AWS VPC CNI)
- kube-proxy
- DaemonSet と Deployment の違い
- Pod と Container の違い

📄 詳細は以下

- [03_kube-system理解.md](docs/03_kube-system理解.md)

---

## ④ Ingress の理解

AWS Load Balancer Controller を利用し、  
Ingress から ALB が自動作成される仕組みを確認した

### 学んだこと

- Service と Ingress の役割
- Ingress Controller の必要性
- ALB の自動作成
- Kubernetes と AWS の連携

📄 詳細は以下

- [04_Ingress理解.md](docs/04_Ingress理解.md)

---

## ⑤ Argo CD (GitOps)

GitHub Repository を Single Source of Truth とし、  
GitOps によるアプリケーション管理を検証した

### 学んだこと

- GitOps の基本概念
- Argo CD Application の構成
- Git Push による自動同期
- Deployment → ReplicaSet → Pod の流れ
- Scheduler の役割
- Node の Pod 上限による Pending 発生

📄 詳細は以下

- [05_ArgoCD理解.md](docs/05_ArgoCD理解.md)

---

# 今後の予定

今後は、より実践的な EKS 運用を想定した検証を実施予定

- Spot Node の自動スケーリング
- Node の自動集約 (Consolidation)
- Node 障害時の Pod 再配置
- Spot Interruption の検証
- NodeClaim のライフサイクル確認
- GitOps による複数アプリケーション管理

---
