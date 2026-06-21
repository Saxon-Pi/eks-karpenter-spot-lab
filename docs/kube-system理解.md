# kube-system 理解

```bash
kubectl get pods -n kube-system -o wide
kubectl get deployment -n kube-system coredns -o yaml
kubectl get daemonset -n kube-system aws-node -o yaml
kubectl get daemonset -n kube-system kube-proxy -o yaml
```

| コンポーネント | 種別 | 役割 |
| --- | --- | --- |
| CoreDNS | Deployment | Cluster内DNS。PodがService名や外部FQDNを名前解決する |
| aws-node | DaemonSet | Amazon VPC CNI。PodにVPC IPを割り当てる |
| kube-proxy | DaemonSet | Service / ClusterIP 通信をNode上で実現する |

```bash
kubectl get pods -n kube-system -o wide

NAME                       READY   STATUS    RESTARTS   AGE   IP             NODE                                             NOMINATED NODE   READINESS GATES
aws-node-c2thr             2/2     Running   0          10m   10.0.254.99    ip-10-0-254-99.ap-northeast-1.compute.internal   <none>           <none>
coredns-6b8858d7f5-sjvxx   1/1     Running   0          14m   10.0.196.116   ip-10-0-254-99.ap-northeast-1.compute.internal   <none>           <none>
coredns-6b8858d7f5-zwcwr   1/1     Running   0          14m   10.0.241.179   ip-10-0-254-99.ap-northeast-1.compute.internal   <none>           <none>
kube-proxy-dpnsr           1/1     Running   0          10m   10.0.254.99    ip-10-0-254-99.ap-northeast-1.compute.internal   <none>           <none>
```

## CoreDNS の名前解決確認

### 目的

Kubernetes Cluster 内で CoreDNS がどのように Service 名を名前解決しているかを確認する  

今回の検証では、dns-test Pod から Kubernetes API Server 用 Service である kubernetes.default.svc.cluster.local を名前解決し、CoreDNS が Service 名から ClusterIP を返すことを確認する  

---

### CoreDNS とは

CoreDNS は Kubernetes Cluster 内の DNS サーバーとして機能する  

Pod は Service 名で通信先を指定できるが、実際に通信するためには IP アドレスが必要になる  
CoreDNS は以下のような Service の FQDN を ClusterIP に変換する  

```
kubernetes.default.svc.cluster.local
↓
172.20.0.1
```

つまり、CoreDNS は Kubernetes 内部における名前解決を担当する  

---

### 現在の kube-system Pod

```bash
kubectl get pods -n kube-system -o wide
```

実行結果  

```
NAME                       READY   STATUS    RESTARTS   AGE   IP             NODE                                             NOMINATED NODE   READINESS GATES
aws-node-c2thr             2/2     Running   0          23m   10.0.254.99    ip-10-0-254-99.ap-northeast-1.compute.internal   <none>           <none>
coredns-6b8858d7f5-sjvxx   1/1     Running   0          26m   10.0.196.116   ip-10-0-254-99.ap-northeast-1.compute.internal   <none>           <none>
coredns-6b8858d7f5-zwcwr   1/1     Running   0          26m   10.0.241.179   ip-10-0-254-99.ap-northeast-1.compute.internal   <none>           <none>
kube-proxy-dpnsr           1/1     Running   0          23m   10.0.254.99    ip-10-0-254-99.ap-northeast-1.compute.internal   <none>           <none>
```

CoreDNS は kube-system namespace 上で Deployment として動作している  

```bash
kubectl get pods -n kube-system -l k8s-app=kube-dns -o wide
```
```
NAME                       READY   STATUS    RESTARTS   AGE   IP             NODE                                             NOMINATED NODE   READINESS GATES
coredns-6b8858d7f5-sjvxx   1/1     Running   0          20m   10.0.196.116   ip-10-0-254-99.ap-northeast-1.compute.internal   <none>           <none>
coredns-6b8858d7f5-zwcwr   1/1     Running   0          20m   10.0.241.179   ip-10-0-254-99.ap-northeast-1.compute.internal   <none>           <none>
```

---

### CoreDNS の設定

```bash
kubectl get configmap coredns -n kube-system -o yaml
```

```yaml
apiVersion: v1
data:
  Corefile: |
    .:53 {
        errors
        health {
            lameduck 5s
          }
        ready
        kubernetes cluster.local in-addr.arpa ip6.arpa {
          pods insecure
          fallthrough in-addr.arpa ip6.arpa
        }
        prometheus :9153
        forward . /etc/resolv.conf
        cache 30
        loop
        reload
        loadbalance
    }
kind: ConfigMap
metadata:
  labels:
    eks.amazonaws.com/component: coredns
    k8s-app: kube-dns
  name: coredns
  namespace: kube-system
```

重要なのは以下の設定  

```
kubernetes cluster.local in-addr.arpa ip6.arpa
```

この設定により、CoreDNS は cluster.local ドメイン配下の Kubernetes Service 名を解決できる  

---

### 名前解決テスト

dns-test Pod を一時的に作成し、kubernetes.default.svc.cluster.local を名前解決する  
（dns-test Pod は送信元 Pod であり、nslookup を実行して名前解決している）  

```bash
kubectl run dns-test \
  --image=busybox:1.36 \
  -it --rm \
  --restart=Never \
  -- nslookup kubernetes.default.svc.cluster.local
```

実行結果  

```
Server:         172.20.0.10     # 今回問い合わせた DNS サーバ (CoreDNS)
Address:        172.20.0.10:53  # DNS のポート番号
Name:   kubernetes.default.svc.cluster.local  # 問い合わせた名前
Address: 172.20.0.1             # 名前解決結果
pod "dns-test" deleted from default namespace
```

ここで確認できることは以下  

```
DNS Server: 172.20.0.10
解決対象: kubernetes.default.svc.cluster.local
解決結果: 172.20.0.1
```

172.20.0.10 は Cluster 内で利用される DNS サーバー、つまり CoreDNS Service の IP  
172.20.0.1 は Kubernetes API Server 用 Service の ClusterIP  

---

### Kubernetes Service の確認

```bash
kubectl get svc kubernetes -n default
```

```
NAME         TYPE        CLUSTER-IP   EXTERNAL-IP   PORT(S)   AGE
kubernetes   ClusterIP   172.20.0.1   <none>        443/TCP   22m
```

名前解決結果として返ってきた 172.20.0.1 は、実際に kubernetes Service の ClusterIP と一致している  

---

### 今回確認した通信の流れ

今回の検証で確認したのは、通信先への実通信ではなく、Service 名の名前解決まで  

```
dns-test Pod
  ↓
CoreDNS Service
172.20.0.10:53
  ↓
CoreDNS Pod
  ↓
kubernetes.default.svc.cluster.local を解決
  ↓
172.20.0.1 を返却
```

つまり、今回確認できたのは以下  

```
Service FQDN
↓
CoreDNS
↓
ClusterIP
```

---

### 注意点

今回の nslookup は DNS 問い合わせのみを行っている  
そのため、以下の通信までは確認していない  

```
dns-test Pod
  ↓
kubernetes Service 172.20.0.1
  ↓
API Server
```

Service の ClusterIP にアクセスした後、実際にバックエンドへ転送される仕組みは kube-proxy が担当する  

---

### CoreDNS と kube-proxy の役割分担

CoreDNS と kube-proxy は役割が異なる  

```
CoreDNS
→ Service 名を ClusterIP に名前解決する

kube-proxy
→ ClusterIP 宛の通信を実際の Pod や API Server へ転送する
```

今回の検証では CoreDNS による名前解決までを確認した  
次の検証では、Service 宛の通信が kube-proxy によって Pod へ転送される流れを確認する  

---

## kube-proxy

```bash
kubectl create deployment nginx \
  --image=nginx
```

```bash
kubectl expose deployment nginx \
  --port 80
```

```
kubectl get svc nginx
```

```bash
kubectl run curl \
  --image=curlimages/curl \
  -it --rm \
  --restart=Never \
  -- curl http://nginx
```

```
Service
 ↓
ClusterIP
 ↓
kube-proxy
 ↓
実Podへ転送
```

## aws-node

```bash
kubectl get daemonset aws-node -n kube-system
```

```bash
kubectl get pods -n kube-system -l k8s-app=aws-node -o wide
```

```bash
kubectl get nodes
```
