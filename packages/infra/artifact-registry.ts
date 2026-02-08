import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

const stack = pulumi.getStack();
const gcpConfig = new pulumi.Config("gcp");
const project = gcpConfig.require("project");
const region = "asia-northeast1" as const;

const repositoryId = `image-processor-${stack}`;

export const registry = new gcp.artifactregistry.Repository(
	"image-processor-repo",
	{
		repositoryId,
		location: region,
		format: "DOCKER",
		description: "Docker images for the image-processor Cloud Run service",
		cleanupPolicyDryRun: false,
		cleanupPolicies: [
			{
				id: "keep-recent-images",
				action: "KEEP",
				mostRecentVersions: {
					packageNamePrefixes: [],
					keepCount: 3,
				},
			},
			{
				id: "delete-old-untagged",
				action: "DELETE",
				condition: {
					tagState: "UNTAGGED",
					olderThan: "7d",
				},
			},
		],
	},
);

export const registryUrl = pulumi.interpolate`${region}-docker.pkg.dev/${project}/${registry.repositoryId}`;
