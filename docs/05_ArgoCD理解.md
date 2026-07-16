# Argo CD (GitOps)

## 目的

Argo CD によって、Git Repository を Single Source of Truth とし、  
EKS Cluster の Manifest を自動同期する。

---

## 今回の構成

GitOps 構成は以下となる  

```text
Developer
    │
git push
    ↓
GitHub (develop)
    ↓
Argo CD
    ↓
Gitとの差分検知
    ↓
kubectl apply
    ↓
Deployment
Service
Ingress
```
