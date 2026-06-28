# AWS Load Balancer Controller / Ingress

- [AWS Load Balancer Controller / Ingress](#aws-load-balancer-controller--ingress)
  - [目的](#目的)
  - [今回の構成](#今回の構成)
  - [Ingress Manifest](#ingress-manifest)
  - [Ingress 作成](#ingress-作成)
  - [AWS Load Balancer Controller の動作](#aws-load-balancer-controller-の動作)
  - [TargetGroupBinding 確認](#targetgroupbinding-確認)

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

上記より、TargetGroupBinding により、
Kubernetes Service と AWS Target Group が関連付けられていることを確認できた。
