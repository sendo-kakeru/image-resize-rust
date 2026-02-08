// 使っていない。不要かも

import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import { registryUrl } from "./artifact-registry";
import { r2BucketName } from "./r2";

const stack = pulumi.getStack();
const region = "asia-northeast1" as const;

const appConfig = new pulumi.Config("app");
const r2Endpoint = appConfig.require("r2Endpoint");
const r2AccessKeyId = appConfig.requireSecret("r2AccessKeyId");
const r2SecretAccessKey = appConfig.requireSecret("r2SecretAccessKey");

const serviceName = `image-processor-${stack}`;

// NOTE: コンテナイメージは CI (gcloud run deploy) で更新する。
// Pulumi はサービス定義のみ管理し、image の変更は ignoreChanges で無視する。
export const service = new gcp.cloudrunv2.Service(
	"image-processor",
	{
		name: serviceName,
		location: region,
		deletionProtection: false,
		ingress: "INGRESS_TRAFFIC_ALL",
		template: {
			containers: [
				{
					image: pulumi.interpolate`${registryUrl}/image-processor:latest`,
					ports: { containerPort: 8080 },
					resources: {
						limits: {
							memory: "1Gi",
							cpu: "1",
						},
					},
					envs: [
						{ name: "R2_ENDPOINT", value: r2Endpoint },
						{
							name: "R2_ACCESS_KEY_ID",
							value: r2AccessKeyId,
						},
						{
							name: "R2_SECRET_ACCESS_KEY",
							value: r2SecretAccessKey,
						},
						{ name: "R2_BUCKET_NAME", value: r2BucketName },
					],
					startupProbe: {
						httpGet: { path: "/health" },
						initialDelaySeconds: 0,
						periodSeconds: 3,
						failureThreshold: 10,
					},
					livenessProbe: {
						httpGet: { path: "/health" },
						periodSeconds: 30,
					},
				},
			],
			scaling: {
				minInstanceCount: 0,
				maxInstanceCount: 5,
			},
			maxInstanceRequestConcurrency: 80,
		},
	},
	{ ignoreChanges: ["template.containers[0].image"] },
);

// Allow unauthenticated access (Workers -> Cloud Run)
new gcp.cloudrunv2.ServiceIamMember("image-processor-invoker", {
	name: service.name,
	location: region,
	role: "roles/run.invoker",
	member: "allUsers",
});

export const serviceUrl = service.uri;
