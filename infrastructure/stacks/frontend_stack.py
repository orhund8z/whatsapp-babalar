from aws_cdk import (
    Stack, RemovalPolicy,
    aws_s3 as s3,
    aws_cloudfront as cf,
    aws_cloudfront_origins as origins,
    aws_s3_deployment as s3deploy,
    aws_certificatemanager as acm,
    CfnOutput,
)
from constructs import Construct


class FrontendStack(Stack):
    def __init__(self, scope: Construct, id: str, **kwargs):
        super().__init__(scope, id, **kwargs)

        domain   = self.node.try_get_context("domain")
        cert_arn = self.node.try_get_context("cert_arn")
        alb_dns  = self.node.try_get_context("alb_dns") or ""

        bucket = s3.Bucket(
            self, "FrontendBucket",
            removal_policy=RemovalPolicy.DESTROY,
            auto_delete_objects=True,
            block_public_access=s3.BlockPublicAccess.BLOCK_ALL,
        )

        certificate = None
        domain_names = None
        if cert_arn and domain:
            certificate  = acm.Certificate.from_certificate_arn(self, "Cert", cert_arn)
            domain_names = [domain]

        # /api/* routes to ALB (caching disabled, all methods, all headers forwarded)
        additional_behaviors = {}
        if alb_dns:
            additional_behaviors["/api/*"] = cf.BehaviorOptions(
                origin=origins.HttpOrigin(
                    alb_dns,
                    protocol_policy=cf.OriginProtocolPolicy.HTTP_ONLY,
                ),
                viewer_protocol_policy=cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cache_policy=cf.CachePolicy.CACHING_DISABLED,
                origin_request_policy=cf.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
                allowed_methods=cf.AllowedMethods.ALLOW_ALL,
            )

        spa_router = cf.Function(
            self, "SpaRouter",
            code=cf.FunctionCode.from_inline("""
function handler(event) {
    var request = event.request;
    var leaf = request.uri.split('/').pop();
    if (request.uri.indexOf('/api/') !== 0 && leaf.indexOf('.') === -1) {
        request.uri = '/index.html';
    }
    return request;
}
"""),
        )

        distribution = cf.Distribution(
            self, "Distribution",
            default_behavior=cf.BehaviorOptions(
                origin=origins.S3BucketOrigin.with_origin_access_control(bucket),
                viewer_protocol_policy=cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
                cache_policy=cf.CachePolicy.CACHING_OPTIMIZED,
                function_associations=[cf.FunctionAssociation(
                    function=spa_router,
                    event_type=cf.FunctionEventType.VIEWER_REQUEST,
                )],
            ),
            additional_behaviors=additional_behaviors,
            default_root_object="index.html",
            price_class=cf.PriceClass.PRICE_CLASS_100,
            geo_restriction=cf.GeoRestriction.allowlist("DE"),
            domain_names=domain_names,
            certificate=certificate,
        )

        s3deploy.BucketDeployment(
            self, "Deploy",
            sources=[s3deploy.Source.asset("../babalar-frontend/dist")],
            destination_bucket=bucket,
            distribution=distribution,
            distribution_paths=["/*"],
        )

        CfnOutput(self, "CloudFrontURL", value=f"https://{distribution.distribution_domain_name}")
        CfnOutput(self, "BucketName", value=bucket.bucket_name)
