import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

const stack = pulumi.getStack();
const appConfig = new pulumi.Config("app");
const accountId = appConfig.require("accountId");

export const r2Bucket = new cloudflare.R2Bucket("image-store", {
	accountId,
	name: `image-store-${stack}`,
	location: "apac",
});

export const r2BucketName = r2Bucket.name;
