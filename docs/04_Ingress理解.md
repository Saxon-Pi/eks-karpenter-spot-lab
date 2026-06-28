# AWS Load Balancer Controller / Ingress

- [AWS Load Balancer Controller / Ingress](#aws-load-balancer-controller--ingress)
  - [目的](#目的)
  - [今回の構成](#今回の構成)
  - [Ingress Manifest](#ingress-manifest)
  - [Ingress 作成](#ingress-作成)
  - [AWS Load Balancer Controller の動作](#aws-load-balancer-controller-の動作)
  - [TargetGroupBinding 確認](#targetgroupbinding-確認)
  - [Target Group 確認](#target-group-確認)
  - [外部通信確認](#外部通信確認)
  - [通信フロー](#通信フロー)
  - [Ingress は通信経路ではない](#ingress-は通信経路ではない)
  - [今回の各コンポーネントの役割](#今回の各コンポーネントの役割)
  - [Cluster 内通信との違い](#cluster-内通信との違い)
  - [学んだこと](#学んだこと)

---

## 目的

AWS Load Balancer Controller を利用して ALB を自動作成し、  
インターネットから Kubernetes Cluster 内の Pod へアクセスできることを確認する  

今回の検証では以下の流れを確認する  

- Ingress 作成により AWS Load Balancer Controller が ALB を作成する
- Target Group に Pod IP が登録される
- ALB の DNS 名から nginx Pod へアクセスできる

---

## 今回の構成

```text
Internet
      │
      ▼
ALB (AWS)
      │
      ▼
Target Group
      │
      ▼
nginx Pod ×3
```

Ingress は実際の通信経路ではなく、  
**AWS Load Balancer Controller が ALB・Target Group を作成するための設定情報**  
として利用される。  

---

## Ingress Manifest

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: nginx-ingress
  annotations:
    alb.ingress.kubernetes.io/scheme: internet-facing
    alb.ingress.kubernetes.io/target-type: ip
spec:
  ingressClassName: alb

  rules:
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: nginx-service
                port:
                  number: 80
```

### ポイント  

今回は `target-type: ip` を指定したため、  
Target Group には Node ではなく Pod IP が登録される  

```yaml
alb.ingress.kubernetes.io/target-type: ip
```

---

## Ingress 作成

```bash
kubectl apply -f k8s/ingress/nginx-ingress.yaml
```

Ingress 作成確認  

```bash
kubectl get ingress
```

結果  

```log
NAME            CLASS   ADDRESS
nginx-ingress   alb     k8s-default-nginxing-d6d45d467f-662625997.ap-northeast-1.elb.amazonaws.com
```

Ingress に ALB の DNS 名が割り当てられたことを確認できた  

---

## AWS Load Balancer Controller の動作

Controller のログを確認する  

```bash
kubectl logs \
-n kube-system \
deployment/aws-load-balancer-controller
```

ログには以下が出力された（一部抜粋）  

```log
{"level":"info","ts":"2026-06-28T01:38:56Z","logger":"controllers.ingress","msg":"creating loadBalancer","stackID":"default/nginx-ingress","resourceID":"LoadBalancer"}
{"level":"info","ts":"2026-06-28T01:38:57Z","logger":"controllers.ingress","msg":"created loadBalancer","stackID":"default/nginx-ingress","resourceID":"LoadBalancer",

...

{"level":"info","ts":"2026-06-28T01:57:52Z","logger":"controllers.ingress","msg":"creating targetGroup","stackID":"default/nginx-ingress","resourceID":"default/nginx-ingress-nginx-service:80"}

...

{"level":"info","ts":"2026-06-28T01:57:54Z","msg":"registering targets","arn":"arn:aws:elasticloadbalancing:ap-northeast-1:<account_id>:targetgroup/k8s-default-nginxser-f26b9af06e/858b4dac19c5fc1c","targets":[{"Id":"10.0.227.42","AvailabilityZone":null,"Port":80,"QuicServerId":null},{"Id":"10.0.230.242","AvailabilityZone":null,"Port":80,"QuicServerId":null},{"Id":"10.0.249.82","AvailabilityZone":null,"Port":80,"QuicServerId":null}]}
```

上記を要約すると以下となる  

```log
creating loadBalancer
created loadBalancer

creating targetGroup
created targetGroup

creating targetGroupBinding
created targetGroupBinding

registering targets
```

さらに、

```log
targets:
- 10.0.227.42
- 10.0.230.242
- 10.0.249.82
```

と出力されており、  
nginx Pod の IP が Target Group に登録されたことが確認できた  

---

## TargetGroupBinding 確認

```bash
kubectl get targetgroupbindings -A
```

```log
NAMESPACE   NAME                              SERVICE-NAME   TARGET-TYPE
default     k8s-default-nginxser-f26b9af06e   nginx-service  ip
```

詳細を確認する  

```bash
kubectl describe targetgroupbinding \
k8s-default-nginxser-f26b9af06e \
-n default
```

```log
Service Ref:
  Name: nginx-service
  Port: 80

Target Type: ip

Target Group ARN:
arn:aws:elasticloadbalancing:ap-northeast-1:<account_id>:targetgroup/k8s-default-nginxser-f26b9af06e/858b4dac19c5fc1c
```

上記より、TargetGroupBinding によって  
Kubernetes Service と AWS Target Group が関連付けられていることを確認できた  

---

## Target Group 確認

AWS コンソール上でも Target Group を確認する  

登録された Target は以下の 3 Pod となっており、  
すべて Healthy となっていることを確認した  

```
10.0.230.242:80
10.0.227.42:80
10.0.249.82:80
```

---

## 外部通信確認

ALB の DNS 名へアクセスする  

```bash
curl http://k8s-default-nginxing-d6d45d467f-662625997.ap-northeast-1.elb.amazonaws.com
```

結果  

```html
<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
<style>
html { color-scheme: light dark; }
body { width: 35em; margin: 0 auto;
font-family: Tahoma, Verdana, Arial, sans-serif; }
</style>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, nginx is successfully installed and working.
Further configuration is required for the web server, reverse proxy, 
API gateway, load balancer, content cache, or other features.</p>

<p>For online documentation and support please refer to
<a href="https://nginx.org/">nginx.org</a>.<br/>
To engage with the community please visit
<a href="https://community.nginx.org/">community.nginx.org</a>.<br/>
For enterprise grade support, professional services, additional 
security features and capabilities please refer to
<a href="https://f5.com/nginx">f5.com/nginx</a>.</p>

<p><em>Thank you for using nginx.</em></p>
</body>
</html>
```

nginx の HTML が返却され、  
インターネットから Pod まで通信できることを確認できた  

---

## 通信フロー

今回実際に通信した経路は以下となる  

```text
Client
      │
      ▼
ALB
      │
      ▼
Listener (:80)
      │
      ▼
Target Group
      │
      ├── 10.0.230.242
      ├── 10.0.227.42
      └── 10.0.249.82
              │
              ▼
          nginx Pod
```

---

## Ingress は通信経路ではない

Ingress は通信を中継するコンポーネントではない  

Ingress は、

- どの Service を
- どの URL に公開するか

という設定を保持する Kubernetes リソースである  

AWS Load Balancer Controller は Ingress を監視し、  

```
Ingress
    │
    ▼
AWS Load Balancer Controller
    │
    ▼
ALB
Target Group
Listener
TargetGroupBinding
```

を自動作成する  

そのため、通信時には Ingress 自身は経由しない  

---

## 今回の各コンポーネントの役割

| コンポーネント | 役割 |
| --- | --- |
| Ingress | 外部公開ルールを定義する |
| AWS Load Balancer Controller | Ingress を監視し ALB・Target Group を自動作成する |
| TargetGroupBinding | Service と AWS Target Group を関連付ける |
| Target Group | Pod IP を登録し、ALB からの通信先となる |
| aws-node | Pod に VPC 内の IP アドレスを割り当てる |
| ALB | インターネットからの HTTP リクエストを Target Group へ転送する |

---

## Cluster 内通信との違い

ここまでで、内部通信と外部通信の仕組みの違いを確認できた  

### Cluster 内通信

CoreDNS が Service 名を名前解決し、kube-proxy が ClusterIP 宛の通信を Pod へ転送する  

```text
Pod
 ↓
CoreDNS
 ↓
Service (ClusterIP)
 ↓
kube-proxy
 ↓
Pod
```

---

### 外部通信

Ingress をもとに AWS Load Balancer Controller が ALB を構築し、  
Target Group に登録された Pod IP を宛先として ALB がルーティングする   

```text
Client
 ↓
ALB
 ↓
Target Group
 ↓
Pod IP
 ↓
Pod
```

---

## 学んだこと

- Ingress は通信経路ではなく、ALB を構築するための設定情報である
- AWS Load Balancer Controller が Ingress を監視し、ALB・Listener・Target Group・TargetGroupBinding を自動作成する
- target-type: ip を指定すると、Target Group には Node ではなく Pod IP が登録される
- aws-node (AWS VPC CNI) が Pod に VPC の IP アドレスを割り当てることで、ALB から Pod へ直接ルーティングできる
- Cluster 内通信（CoreDNS・Service・kube-proxy）と、外部通信（ALB・Target Group）の経路は異なる

ここまでの検証により、  
Kubernetes Cluster 内部では CoreDNS・Service・kube-proxy が通信を実現し、  
Cluster 外部との通信では AWS Load Balancer Controller・ALB・Target Group が連携することで、  
Pod をインターネットへ公開できることを確認できた  

---
