<!-- omit in toc -->
# kube-system 理解

- [目的](#目的)
- [CoreDNS の名前解決確認](#coredns-の名前解決確認)
- [CoreDNS / Service による Pod 間通信確認](#coredns--service-による-pod-間通信確認)
- [aws-node (AWS VPC CNI) の IP 割り当て確認](#aws-node-aws-vpc-cni-の-ip-割り当て確認)

---

## 目的

EKS クラスター上で動作する kube-system コンポーネントの役割を理解する  

特に Pod 間通信が成立するまでの流れを追いながら、  

- CoreDNS
- Service (ClusterIP)
- kube-proxy
- aws-node (AWS VPC CNI)

がそれぞれ何を担当しているのかを確認する  

最終的に以下の通信経路を説明できる状態を目指す  

```text
Pod
 ↓
CoreDNS
 ↓
ClusterIP
 ↓
kube-proxy
 ↓
Pod IP
 ↓
aws-node
 ↓
ENI
 ↓
VPC
```

---

### 検証項目

- CoreDNS の名前解決確認
- CoreDNS / Service による Pod 間通信確認
- aws-node (AWS VPC CNI) の IP 割り当て確認

---

### kube-system コンポーネント一覧

```bash
kubectl get pods -n kube-system -o wide

kubectl get deployment -n kube-system coredns -o yaml
kubectl get daemonset -n kube-system aws-node -o yaml
kubectl get daemonset -n kube-system kube-proxy -o yaml
```

| コンポーネント | 種別 | 役割 |
| --- | --- | --- |
| CoreDNS | Deployment | Service名 → ClusterIP の名前解決 |
| aws-node | DaemonSet | Pod IP を VPC から払い出す |
| kube-proxy | DaemonSet | ClusterIP → Pod のルーティング |
| Service | Kubernetes Resource | Pod の集合を表現し、固定の仮想IPを提供 |

---

### 今回理解したい全体像

```text
① Pod が Service 名で通信する

curl http://nginx-service

        ↓

② CoreDNS が名前解決

nginx-service
        ↓
172.20.194.45

        ↓

③ kube-proxy が転送

172.20.194.45
        ↓
10.0.x.x

        ↓

④ aws-node が管理する Pod IP に到達

Pod
```

---

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

## aws-node (AWS VPC CNI) の IP 割り当て確認

### 目的

Kubernetes Pod に割り当てられる IP アドレスがどこから来ているのかを確認する

今回の検証では以下を確認する  

- aws-node が DaemonSet として各 Node 上で動作していること
- Pod IP が VPC CIDR から割り当てられていること
- Pod IP が EC2 の ENI に紐付いていること

---

### aws-node とは

aws-node は EKS 標準の CNI (Container Network Interface) プラグインである  
（正式には AWS VPC CNI と呼ばれる）  

CoreDNS や kube-proxy が DNS や Service 転送を担当するのに対し、aws-node は Pod のネットワーク設定を担当する  

具体的には以下を実施している

```text
Pod 作成
 ↓
aws-node
 ↓
VPC 内の IP を確保
 ↓
Pod に割り当て
 ↓
Pod が VPC ネットワークへ参加
```

---

### DaemonSet の確認

aws-node は DaemonSet として動作している

```bash
kubectl get daemonset -n kube-system
```

実行結果

```log
NAME         DESIRED   CURRENT   READY
aws-node     1         1         1
kube-proxy   1         1         1
```

DaemonSet のため Node ごとに 1 Pod 起動される  

```text
Node1
 ├ aws-node
 └ kube-proxy

Node2
 ├ aws-node
 └ kube-proxy
```

---

### aws-node Pod の確認

```bash
kubectl get pods -n kube-system -o wide
```

実行結果

```log
NAME             READY   IP
aws-node-qskwd   2/2     10.0.172.28
```

Node 情報を確認する

```bash
kubectl describe node ip-10-0-172-28.ap-northeast-1.compute.internal
```

実行結果

```log
InternalIP: 10.0.172.28
```

aws-node Pod の IP と Node の InternalIP が一致している  
→ aws-node が hostNetwork を利用して Node ネットワーク上で動作しているため  

```text
Node
10.0.172.28
   │
   └ aws-node Pod
      10.0.172.28
```

---

### Pod IP の確認

現在の Pod 一覧を取得  

```bash
kubectl get pods -A -o wide
```

実行結果  

```log
NAMESPACE     NAME                       IP
kube-system   aws-node-qskwd             10.0.172.28
kube-system   coredns-5566996c6f-4xs4f   10.0.178.17
kube-system   coredns-5566996c6f-mwcnp   10.0.170.215
kube-system   kube-proxy-jb9dv           10.0.172.28
```

CoreDNS Pod には個別の Pod IP が割り当てられていることが分かる

```text
coredns
 ├ 10.0.178.17
 └ 10.0.170.215
```

---

### VPC CIDR の確認

EKS 用 VPC

```text
VPC CIDR
10.0.0.0/16
```

Pod の IP を見ると、すべて VPC CIDR 内であることが分かる  
→ aws-node は VPC のアドレス空間から Pod IP を割り当てている  

```text
10.0.178.17
10.0.170.215
10.0.172.28
```

### ENI の確認

EC2 側のネットワーク情報を確認する  

```bash
aws ec2 describe-instances \
  --profile <user-name> \
  --region ap-northeast-1 \
  --filters "Name=private-dns-name,Values=ip-10-0-172-28.ap-northeast-1.compute.internal" \
  --query 'Reservations[*].Instances[*].[InstanceId,PrivateIpAddress,NetworkInterfaces[*].PrivateIpAddresses[*].PrivateIpAddress]' \
  --output json
```

実行結果  

```json
[
  [
    [
      "i-00cd2875b5db4ef37",
      "10.0.172.28",
      [
        [
          "10.0.172.28",
          "10.0.178.17",
          "10.0.170.215",
          "10.0.162.199",
          "10.0.167.56",
          "10.0.171.123"
        ]
      ]
    ]
  ]
]
```

EC2 インスタンスには複数の Private IP がアタッチされていて、  
その中に CoreDNS Pod の IP が存在する  

```text
10.0.178.17
10.0.170.215
```

→ Pod IP は EC2 の ENI に割り当てられた Secondary Private IP を利用していることが確認できる

---

### 今回確認した流れ

```text
Pod 作成
 ↓
aws-node
 ↓
EC2 ENI の Secondary IP を確保
 ↓
Pod へ割り当て
 ↓
Pod が VPC ネットワークへ参加
```

実際には以下の関係になっている

```text
EC2 Node
10.0.172.28

ENI
 ├ 10.0.172.28
 ├ 10.0.178.17
 ├ 10.0.170.215
 ├ 10.0.162.199
 ├ 10.0.167.56
 └ 10.0.171.123

CoreDNS Pod
 ├ 10.0.178.17
 └ 10.0.170.215
```

---

### CoreDNS / kube-proxy / aws-node の役割分担

今回の検証で kube-system の主要コンポーネントの役割を確認できた  

```text
CoreDNS
↓
Service名 → ClusterIP

kube-proxy
↓
ClusterIP → Pod

aws-node (VPC CNI)
↓
PodへIP割り当て
```

通信全体で見ると以下の流れになる  

```text
Pod
 ↓
CoreDNS
 ↓
ClusterIP

 ↓
kube-proxy
 ↓
Pod IP

 ↓
aws-node が割り当てた VPC IP
```

---

学んだこと

- aws-node は AWS VPC CNI の実体である
- aws-node は DaemonSet として各 Node に 1 Pod 配置される
- Pod IP は VPC CIDR から払い出される
- Pod IP は EC2 ENI の Secondary Private IP を利用している
- CoreDNS や kube-proxy と異なり、aws-node はネットワークアドレス管理を担当する
- EKS の Pod は VPC ネットワーク上の IP を直接持つため、AWS リソースとの通信がシンプルに実現できる

---
