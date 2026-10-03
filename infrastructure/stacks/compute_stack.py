from aws_cdk import (
    Stack,
    aws_ec2 as ec2,
    aws_iam as iam,
    aws_elasticloadbalancingv2 as elbv2,
    aws_autoscaling as asg,
    CfnOutput,
)
from constructs import Construct


class ComputeStack(Stack):
    def __init__(
        self,
        scope: Construct,
        id: str,
        vpc: ec2.Vpc,
        ec2_sg: ec2.SecurityGroup,
        alb_sg: ec2.SecurityGroup,
        db_endpoint: str,
        **kwargs,
    ):
        super().__init__(scope, id, **kwargs)

        repo_url = self.node.try_get_context("repo_url") or ""
        region   = self.region

        # ALB lives here to avoid a cross-stack cycle with NetworkStack
        self.alb = elbv2.ApplicationLoadBalancer(
            self, "ALB",
            vpc=vpc,
            internet_facing=True,
            security_group=alb_sg,
            vpc_subnets=ec2.SubnetSelection(subnet_type=ec2.SubnetType.PUBLIC),
        )

        # IAM Role — SSM + Secrets Manager + CloudWatch Logs
        role = iam.Role(
            self, "EC2Role",
            assumed_by=iam.ServicePrincipal("ec2.amazonaws.com"),
            managed_policies=[
                iam.ManagedPolicy.from_aws_managed_policy_name("CloudWatchLogsFullAccess"),
                iam.ManagedPolicy.from_aws_managed_policy_name("AmazonSSMManagedInstanceCore"),
            ],
        )
        role.add_to_policy(iam.PolicyStatement(
            actions=["secretsmanager:GetSecretValue"],
            resources=[f"arn:aws:secretsmanager:{region}:*:secret:babalar/*"],
        ))

        user_data = ec2.UserData.for_linux()
        user_data.add_commands(f"""
set -euo pipefail
exec > /var/log/babalar-setup.log 2>&1
echo "[babalar] Starting EC2 setup..."

dnf update -y
dnf install -y docker git
systemctl enable --now docker
usermod -aG docker ec2-user

mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL https://github.com/docker/compose/releases/download/v2.27.1/docker-compose-linux-aarch64 \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

git clone {repo_url} /app
cd /app

get_secret() {{
  aws secretsmanager get-secret-value \
    --region {region} --secret-id "$1" \
    --query SecretString --output text
}}

optional_secret() {{
  get_secret "$1" 2>/dev/null || true
}}

DB_PASSWORD=$(get_secret babalar/db-password | python3 -c "import sys,json; print(json.load(sys.stdin)['password'])")
OPENAI_API_KEY=$(get_secret babalar/openai-api-key)
JWT_SECRET=$(get_secret babalar/jwt-secret)
INGEST_API_KEY=$(get_secret babalar/ingest-api-key)
LANGFUSE_PUBLIC_KEY=$(optional_secret babalar/langfuse-public-key)
LANGFUSE_SECRET_KEY=$(optional_secret babalar/langfuse-secret-key)
LANGFUSE_BASE_URL=$(optional_secret babalar/langfuse-base-url)
TYPESAFE_API_KEY=$(optional_secret babalar/typesafe-api-key)
JEV_MODEL=$(optional_secret babalar/jev-model)

cat > /app/.env << ENVEOF
DATABASE_URL=postgresql+asyncpg://babalar:${{DB_PASSWORD}}@{db_endpoint}:5432/babalar
OPENAI_API_KEY=${{OPENAI_API_KEY}}
JWT_SECRET=${{JWT_SECRET}}
JWT_ACCESS_TTL_MINUTES=60
JWT_REFRESH_TTL_DAYS=30
INGEST_API_KEY=${{INGEST_API_KEY}}
BACKEND_URL=http://backend:8000
INGEST_CRON=0 2 * * *
ENVIRONMENT=production
LOG_LEVEL=INFO
ENVEOF

if [ -n "${{LANGFUSE_PUBLIC_KEY}}" ] && [ -n "${{LANGFUSE_SECRET_KEY}}" ]; then
cat >> /app/.env << ENVEOF
LANGFUSE_PUBLIC_KEY=${{LANGFUSE_PUBLIC_KEY}}
LANGFUSE_SECRET_KEY=${{LANGFUSE_SECRET_KEY}}
LANGFUSE_BASE_URL=${{LANGFUSE_BASE_URL:-https://cloud.langfuse.com}}
ENVEOF
fi

if [ -n "${{TYPESAFE_API_KEY}}" ]; then
cat >> /app/.env << ENVEOF
TYPESAFE_API_KEY=${{TYPESAFE_API_KEY}}
JEV_ENABLED=true
JEV_MODEL=${{JEV_MODEL:-jev-1.13.0}}
ENVEOF
fi

docker compose -f docker-compose.prod.yml up -d --build

echo "[babalar] Waiting for backend to be healthy..."
for i in $(seq 1 36); do
  if curl -sf http://localhost:8000/health > /dev/null 2>&1; then
    echo "[babalar] Backend is ready."
    break
  fi
  sleep 5
done

docker compose -f docker-compose.prod.yml exec -T backend python -m alembic upgrade head

echo "[babalar] Setup complete."
echo "[babalar] To create admin: docker compose -f docker-compose.prod.yml exec backend python -m app.cli setup"
""")

        lt = ec2.LaunchTemplate(
            self, "LaunchTemplate",
            instance_type=ec2.InstanceType("t4g.small"),
            machine_image=ec2.MachineImage.latest_amazon_linux2023(cpu_type=ec2.AmazonLinuxCpuType.ARM_64),
            security_group=ec2_sg,
            role=role,
            user_data=user_data,
            block_devices=[
                ec2.BlockDevice(
                    device_name="/dev/xvda",
                    volume=ec2.BlockDeviceVolume.ebs(20, volume_type=ec2.EbsDeviceVolumeType.GP3),
                )
            ],
        )

        self.asg = asg.AutoScalingGroup(
            self, "ASG",
            vpc=vpc,
            launch_template=lt,
            vpc_subnets=ec2.SubnetSelection(subnet_type=ec2.SubnetType.PUBLIC),
            min_capacity=1,
            max_capacity=1,
            desired_capacity=1,
        )

        tg = elbv2.ApplicationTargetGroup(
            self, "TargetGroup",
            vpc=vpc,
            port=8000,
            protocol=elbv2.ApplicationProtocol.HTTP,
            targets=[self.asg],
            health_check=elbv2.HealthCheck(path="/health", healthy_http_codes="200"),
        )

        # HTTP only — CloudFront handles HTTPS termination, no ALB cert needed
        self.alb.add_listener(
            "HTTP",
            port=80,
            default_target_groups=[tg],
        )

        CfnOutput(self, "AlbDnsName", value=self.alb.load_balancer_dns_name)
        CfnOutput(self, "ASGName", value=self.asg.auto_scaling_group_name)
