<!-- omit in toc -->
# kube-system 理解

- [CoreDNS の名前解決確認](#coredns-の名前解決確認)
- [CoreDNS / Service による Pod 間通信確認](#coredns--service-による-pod-間通信確認)
- [aws-node](#aws-node)


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

```text
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

```log
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

```log
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

```text
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

```log
Server:         172.20.0.10     # 今回問い合わせた DNS サーバ (CoreDNS)
Address:        172.20.0.10:53  # DNS のポート番号
Name:   kubernetes.default.svc.cluster.local  # 問い合わせた名前
Address: 172.20.0.1             # 名前解決結果
pod "dns-test" deleted from default namespace
```

ここで確認できることは以下  

```text
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

```log
NAME         TYPE        CLUSTER-IP   EXTERNAL-IP   PORT(S)   AGE
kubernetes   ClusterIP   172.20.0.1   <none>        443/TCP   22m
```

名前解決結果として返ってきた 172.20.0.1 は、実際に kubernetes Service の ClusterIP と一致している  

---

### 今回確認した通信の流れ

今回の検証で確認したのは、通信先への実通信ではなく、Service 名の名前解決まで  

```text
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

```text
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

```text
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

```text
CoreDNS
→ Service 名を ClusterIP に名前解決する

kube-proxy
→ ClusterIP 宛の通信を実際の Pod や API Server へ転送する
```

今回の検証では CoreDNS による名前解決までを確認した  
次の検証では、Service 宛の通信が kube-proxy によって Pod へ転送される流れを確認する  

---

## CoreDNS / Service による Pod 間通信確認

### 目的

Kubernetes Cluster 内で、以下の動作を確認する  

- CoreDNS が Service 名を名前解決すること
- Service が Pod 群を束ねること
- Pod から Service 名で通信できること

---

### 構成

nginx Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx-test
spec:
  replicas: 3
```

nginx Service

```yaml
apiVersion: v1
kind: Service
metadata:
  name: nginx-service
spec:
  selector:
    app: nginx-test
  ports:
    - port: 80
      targetPort: 80
```

---

### Pod 作成確認

```bash
kubectl get pods -o wide
```

nginx Pod が3台起動している  

```log
NAME                          READY   STATUS    IP
nginx-test-6595686b84-4qjhg   1/1     Running   10.0.197.56
nginx-test-6595686b84-pvq7g   1/1     Running   10.0.251.246
nginx-test-6595686b84-rlslk   1/1     Running   10.0.219.79
```

---

### Service 作成確認

```bash
kubectl get svc
```

nginx-service という Service（ClusterIP）が作成された  

```log
NAME            TYPE        CLUSTER-IP
kubernetes      ClusterIP   172.20.0.1
nginx-service   ClusterIP   172.20.194.45
```

---

### CoreDNS による名前解決確認

名前解決（nslookup）確認用 Pod を起動する

```bash
kubectl run dns-test \
  --image=busybox:1.36 \
  -it --rm \
  --restart=Never \
  -- nslookup nginx-service
```

結果

```log
Server: 172.20.0.10
Address: 172.20.0.10:53
Name: nginx-service.default.svc.cluster.local
Address: 172.20.194.45 # 名前解決結果
```

Service 名から ClusterIP への名前解決が成功したことを確認できた  

```text
CoreDNS (172.20.0.10)
  ↓
nginx-service.default.svc.cluster.local
  ↓
172.20.194.45
```

---

### Service が束ねる Pod 確認

```bash
kubectl get endpoints nginx-service
```

結果

```log
NAME            ENDPOINTS
nginx-service   10.0.197.56:80,10.0.219.79:80,10.0.251.246:80
```

Service は selector に一致する Pod を Endpoint として管理していることが確認できた  

```text
nginx-service
 ├ 10.0.197.56:80
 ├ 10.0.219.79:80
 └ 10.0.251.246:80
```

---

### Pod 間通信確認

送信元 Pod を起動する  

```bash
kubectl run curl-test \
  --image=curlimages/curl \
  -it --rm \
  -- sh
```

Pod 内で curl コマンドを実行する  

```bash
curl http://nginx-service
```

結果として、nginx のレスポンスが返却される  

```html
<h1>Welcome to nginx!</h1>
```

---

### 通信フロー

今回確認できた通信経路は以下となる  

```text
curl-test Pod
        │
        │ curl http://nginx-service
        ▼
CoreDNS
        │
        │ 名前解決
        ▼
nginx-service.default.svc.cluster.local
        │
        ▼
172.20.194.45 (ClusterIP)
        │
        ▼
Service / kube-proxy
        │
        ├→ 10.0.197.56
        ├→ 10.0.219.79
        └→ 10.0.251.246
                │
                ▼
           nginx Pod
```

---

### 学んだこと

- Service 作成時に ClusterIP が払い出される
- CoreDNS は Service 名を ClusterIP へ名前解決する
- Service は selector に一致する Pod を Endpoint として管理する
- Pod は Service 名だけで通信できる
- kube-proxy は ClusterIP 宛通信を実際の Pod へ転送する
- Pod 同士は直接 IP を知らなくても Service 名で通信できる

---

### CoreDNS の役割

```text
Service名
↓
ClusterIP
```

への名前解決を担当する  

例

```text
nginx-service.default.svc.cluster.local
↓
172.20.194.45
```

---

### kube-proxy の役割

```
ClusterIP
↓
実際の Pod
```

への転送を担当する  

例

```text
172.20.194.45
↓
10.0.197.56

または

10.0.219.79

または

10.0.251.246
```

ClusterIP は仮想IPであり、実際の Pod へのルーティングは kube-proxy が実施している  

---

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
