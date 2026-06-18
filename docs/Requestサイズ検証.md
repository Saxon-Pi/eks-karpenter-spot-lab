# Request サイズ検証

## 目的

Karpenter が Pod の実使用量ではなく、  
requests をもとに Node をプロビジョニングすることを確認する  

## 比較対象

| Deployment | replicas | cpu request | memory request | 期待する挙動 |
|---|---:|---:|---:|---|
| request-test-light | 3 | 100m | 128Mi | 小さい Node 1台に集約される |
| request-test-heavy | 3 | 1500m | 3Gi | より大きい Node、または複数 Node が作成される |

## 確認コマンド

```bash
kubectl apply -f k8s/workloads/request-test-light.yaml
kubectl apply -f k8s/workloads/request-test-heavy.yaml

kubectl get pods -n karpenter-lab -o wide
kubectl get nodes -L karpenter.sh/capacity-type,node.kubernetes.io/instance-type,workload-type
kubectl get nodeclaims
kubectl describe nodeclaim <nodeclaim-name>
```

## チェック観点

- light/heavy Workload ごとに選択された InstanceType
- 作成された Node 数
- Pod がどの Node に配置されたか
- requests を盛ることで Node 選定がどう変化するか

## 学びたいこと（確認後更新）

過剰な requests は、実使用量が少なくても大きな Node や追加 Node の起動につながる可能性がある  
そのため、Karpenter 環境では requests の適正化がコスト最適化に直結する  
