# 各種 Workload の Req/LIM CPU/Mem を集計するコマンド
ENV_NAME=$(kubectl config current-context | awk -F'/' '{print $NF}')

kubectl get deploy,statefulset,daemonset,cronjob,job -A -o json | jq -r --arg env "$ENV_NAME" '
def cpu_m:
  if . == null then 0
  elif test("m$") then (sub("m$";"") | tonumber)
  else (tonumber * 1000 | floor)
  end;

def mem_mi:
  if . == null then 0
  elif test("Mi$") then (sub("Mi$";"") | tonumber)
  elif test("Gi$") then ((sub("Gi$";"") | tonumber) * 1024 | floor)
  else 0
  end;

[
  "ENV",
  "KIND",
  "NAMESPACE",
  "NAME",
  "REPLICAS",
  "REQ_CPU_m_PER_POD",
  "REQ_MEM_Mi_PER_POD",
  "LIM_CPU_m_PER_POD",
  "LIM_MEM_Mi_PER_POD",
  "TOTAL_REQ_CPU_m",
  "TOTAL_REQ_MEM_Mi",
  "TOTAL_LIM_CPU_m",
  "TOTAL_LIM_MEM_Mi",
  "NODE_SELECTOR",
  "TOLERATIONS"
],
(
  .items[]
  | . as $w
  | ($w.spec.replicas // $w.spec.jobTemplate.spec.parallelism // "-") as $replicas
  | ($w.spec.template.spec.nodeSelector // $w.spec.jobTemplate.spec.template.spec.nodeSelector // {}) as $nodeSelector
  | ($w.spec.template.spec.tolerations // $w.spec.jobTemplate.spec.template.spec.tolerations // []) as $tolerations
  | ($w.spec.template.spec.containers // $w.spec.jobTemplate.spec.template.spec.containers // []) as $containers
  | ($containers | map(.resources.requests.cpu | cpu_m) | add // 0) as $req_cpu
  | ($containers | map(.resources.requests.memory | mem_mi) | add // 0) as $req_mem
  | ($containers | map(.resources.limits.cpu | cpu_m) | add // 0) as $lim_cpu
  | ($containers | map(.resources.limits.memory | mem_mi) | add // 0) as $lim_mem
  | (if ($replicas|type) == "number" then $replicas else 0 end) as $replicas_num
  | [
      $env,
      $w.kind,
      $w.metadata.namespace,
      $w.metadata.name,
      $replicas,
      $req_cpu,
      $req_mem,
      $lim_cpu,
      $lim_mem,
      (if $replicas_num > 0 then ($req_cpu * $replicas_num) else "-" end),
      (if $replicas_num > 0 then ($req_mem * $replicas_num) else "-" end),
      (if $replicas_num > 0 then ($lim_cpu * $replicas_num) else "-" end),
      (if $replicas_num > 0 then ($lim_mem * $replicas_num) else "-" end),
      ($nodeSelector | tojson),
      ($tolerations | tojson)
    ]
)
| @tsv
'
