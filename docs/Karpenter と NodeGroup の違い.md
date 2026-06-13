# Karpenter と NodeGroup の違い

## 従来の NodeGroup 運用

EKS では一般的に Managed Node Group を作成し、  
その NodeGroup 上へ Pod を配置する

```text
EKS Cluster

├─ NodeGroup Small
│   ├─ t3.small
│   ├─ t3.small
│   └─ t3.small
│
├─ NodeGroup Medium
│   ├─ m5.large
│   └─ m5.large
│
└─ NodeGroup Large
    └─ c5.2xlarge
```

アプリケーションは nodeSelector を利用して  
どの NodeGroup に配置するかを指定する

```yaml
nodeSelector:
  workload-type: medium
```

---

## NodeGroup 運用の課題

### サイズ設計が必要

事前に

- Small
- Medium
- Large

などを設計する必要がある  

---

### オーバープロビジョニング

例えば

```text
Pod要求

CPU: 500m
Memory: 512Mi
```

しか使わないのに  

```text
m5.large
2CPU
8Gi
```

を起動してしまう場合がある  

---

### NodeGroupが増える

要件が増えるたびに

```text
small
medium
large

spot-small
spot-medium
spot-large

gpu

critical
```

など NodeGroup が増殖する

---

## Karpenter の考え方

Karpenter は「先に Node を作る」のではなく、  
「Pod を見て必要な Node を作る」という考え方をする

---

### Karpenter 構成

```text
EKS Cluster

├─ system-ng
│   ├─ Karpenter Controller
│   ├─ CoreDNS
│   ├─ kube-proxy
│   └─ aws-node
│
└─ Karpenter
    └─ Node 自動生成
```

### NodePool

Karpenter では NodeGroup の代わりに

```yaml
kind: NodePool
```

を使用する  

---

例:  

```yaml
requirements:

- key: karpenter.sh/capacity-type
  operator: In
  values:
    - spot

- key: karpenter.k8s.aws/instance-family
  operator: In
  values:
    - c
    - m
    - r

- key: karpenter.k8s.aws/instance-size
  operator: In
  values:
    - large
    - xlarge
```

意味:  

```text
Spot

かつ

c系
m系
r系

かつ

large
xlarge
```

の中から自由に選んでよい  

---

### Pod が来た時の動き

#### 軽い Pod

```yaml
requests:
  cpu: 200m
  memory: 256Mi
```

↓  

```text
m7a.large
```

を選択する

#### 重い Pod

```yaml
requests:
  cpu: 4
  memory: 8Gi
```

↓

```text
r7a.xlarge
```

を選択する

---

### NodeGroupとの最大の違い

NodeGroup:

```text
人間が先に Node を決める
```

Karpenter:

```text
Karpenter が Pod を見て Node を決める
```

---

### Spot運用との相性

NodePool で CapacityType を指定するだけで Spot 運用が可能  

```yaml
capacity-type: spot
```

例:  

Spot NodePool の場合

``` yaml
capacity-type:
  - spot
```

OnDemand NodePool の場合

```yaml
capacity-type:
  - on-demand
```

Workload 側の設定  

```yaml
nodeSelector:
  capacity-type: spot
```

これだけで、

- Spot
- OnDemand

を使い分けることができる

---

### 実務でよく見る構成

```text
system-ng
↓
監視・管理系（On-Demand）
```

```text
spot-pool
↓
アプリケーション（Spot）
```

さらに発展すると

```text
spot-general
spot-batch

ondemand-critical

gpu
```

などに分割する

---

### 学んだこと

NodeGroup 時代は

```
Node を管理する
```

運用だったのに対し、Karpenter は

```text
Pod を管理する

Node は自動生成される
```

運用に近い仕組みとなる

---

Karpenter の価値は

- NodeGroup の大量管理が不要
- Pod に応じたサイズを自動選択
- Spot との相性が良い
- コスト最適化しやすい
- スケールアウト／インが高速

であり、  

「Nodeを設計する」から「Pod要件を設計する」へ発想が変わることが最大の特徴となる

---
