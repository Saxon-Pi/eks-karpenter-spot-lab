# Request サイズ検証

## 目的

Karpenter が Pod の実使用量ではなく、  
requests をもとに Node をプロビジョニングすることを確認する  

## 比較対象

| Deployment | replicas	| cpu request | memory request | 期待する挙動 |
| --- | --- | --- | --- | --- |
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

## 検証結果

### light Deployment のみ

Karpenter は Spot の m5.large を 1台作成した
```log
NAME                                              STATUS   ROLES    AGE    VERSION                CAPACITY-TYPE   INSTANCE-TYPE   WORKLOAD-TYPE
ip-10-0-141-255.ap-northeast-1.compute.internal   Ready    <none>   56m    v1.31.13-eks-ecaa3a6                   t3.medium       system
ip-10-0-208-210.ap-northeast-1.compute.internal   Ready    <none>   100s   v1.31.14-eks-93b80c6   spot            m5.large        karpenter-spot
```
```log
NAME                                  READY   STATUS    RESTARTS   AGE   IP             NODE                                              NOMINATED NODE   READINESS GATES
request-test-light-5d77d48478-7mzkv   1/1     Running   0          90s   10.0.203.112   ip-10-0-208-210.ap-northeast-1.compute.internal   <none>           <none>
request-test-light-5d77d48478-jjndj   1/1     Running   0          90s   10.0.217.186   ip-10-0-208-210.ap-northeast-1.compute.internal   <none>           <none>
request-test-light-5d77d48478-zkk2z   1/1     Running   0          90s   10.0.227.228   ip-10-0-208-210.ap-northeast-1.compute.internal   <none>           <none>
```

上記の構成イメージ  

```text
m5.large
├ request-test-light
├ request-test-light
└ request-test-light

kubectl get nodeclaims
NAME         TYPE       CAPACITY
spot-qrf2p   m5.large   spot
```

### heavy Deployment 追加後

Karpenter は Spot の m5.xlarge を追加作成した  

```log
NAME                                              STATUS   ROLES    AGE    VERSION                CAPACITY-TYPE   INSTANCE-TYPE   WORKLOAD-TYPE
ip-10-0-141-255.ap-northeast-1.compute.internal   Ready    <none>   59m    v1.31.13-eks-ecaa3a6                   t3.medium       system
ip-10-0-155-163.ap-northeast-1.compute.internal   Ready    <none>   107s   v1.31.14-eks-93b80c6   spot            m5.xlarge       karpenter-spot
ip-10-0-195-4.ap-northeast-1.compute.internal     Ready    <none>   107s   v1.31.14-eks-93b80c6   spot            m5.large        karpenter-spot
```

```log
NAME                                  READY   STATUS    RESTARTS   AGE    IP             NODE                                              NOMINATED NODE   READINESS GATES
request-test-heavy-8f64c87ff-5r52p    1/1     Running   0          111s   10.0.166.200   ip-10-0-155-163.ap-northeast-1.compute.internal   <none>           <none>
request-test-heavy-8f64c87ff-d2668    1/1     Running   0          111s   10.0.168.253   ip-10-0-155-163.ap-northeast-1.compute.internal   <none>           <none>
request-test-heavy-8f64c87ff-pmj4h    1/1     Running   0          111s   10.0.202.92    ip-10-0-195-4.ap-northeast-1.compute.internal     <none>           <none>
request-test-light-5d77d48478-62cb7   1/1     Running   0          59s    10.0.143.229   ip-10-0-155-163.ap-northeast-1.compute.internal   <none>           <none>
request-test-light-5d77d48478-fcjb7   1/1     Running   0          60s    10.0.247.201   ip-10-0-195-4.ap-northeast-1.compute.internal     <none>           <none>
request-test-light-5d77d48478-j7gm4   1/1     Running   0          60s    10.0.139.17    ip-10-0-155-163.ap-northeast-1.compute.internal   <none>           <none>
```

上記の構成イメージ  

```text
kubectl get nodeclaims
NAME         TYPE
spot-xxxxx   m5.large
spot-yyyyy   m5.xlarge

最終的に Pod は複数 Node に分散配置された

m5.xlarge
├ request-test-heavy
├ request-test-heavy
├ request-test-light
└ request-test-light
m5.large
├ request-test-heavy
└ request-test-light
```

## 考察

Karpenter は Pod の requests をもとに必要な Node を計算していた  

また、単純に「heavy workload = 大きい Node を1台追加」ではなく、

- 既存 Node の余剰リソース
- Pod の配置可能性
- 利用可能な InstanceType

を考慮して Node 構成を決定していることが確認できた  

さらに、Karpenter 自身は Node の作成・削除を担当し、  
Pod のスケジューリングは Kubernetes Scheduler が実施する

Karpenter は Pod を直接移動するのではなく、  
Scheduler が配置できる Node を提供する役割を担う

### 面白かったポイント
今回の検証では heavy Deployment 全体で 4.5CPU を要求していたが、  
Karpenter は workload 単位ではなく Cluster 全体の空きリソースを考慮していた  

その結果、既存 Node の余剰リソースを利用しつつ、  
不足分のみを補う形で m5.xlarge を追加作成していることを確認できた  

## 学んだこと

- Karpenter は実使用量ではなく requests を基準に Node をプロビジョニングする
- requests を過剰に設定すると、大きな InstanceType や追加 Node の起動につながる
- requests の適正化は Karpenter 環境におけるコスト最適化に直結する
- Karpenter は既存 Node の空きリソースも考慮して最適な Node 構成を選択する
