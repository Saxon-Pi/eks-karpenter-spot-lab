# AWS Load Balancer Controller / Ingress

## 目的

EKS Cluster外部からPodへアクセスする仕組みを理解する

## 構成

```text
Internet
↓
ALB
↓
Ingress
↓
Service
↓
Pod
```

## 確認項目

- Ingress 作成
- ALB 自動作成確認
- Target Group 確認
- ブラウザアクセス確認
