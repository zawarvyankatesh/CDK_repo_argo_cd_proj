# Taskboard CI and GitOps promotion

This AWS CDK stack updates the existing CodeBuild project `taskboard-build-and-publish` and retains three ECR repositories. A push to `main` in `zawarvyankatesh/application_code_argocd_project` triggers CodeBuild. It checks source syntax and publisher tests, builds the web and API images, mirrors Redis to ECR, and verifies all three images. Then `scripts/publish_gitops.py` in the application repo updates `charts/taskboard/values.yaml` in [the separate GitOps repo](https://github.com/zawarvyankatesh/HELM_chart_CD_ArgoCDproject). Argo CD watches that GitOps repo and syncs the new image tags into kind.

Only the web and API images use a 12-character application commit tag. Redis stays on `7-alpine`. The publisher skips a stale build if its application commit is no longer the tip of `main`, and it skips the GitOps commit if the values already match. Concurrent builds for this CodeBuild project are limited to one.

## GitHub token prerequisite

The GitHub PAT used to **write to the GitOps repo** is separate from any GitHub credential CodeBuild already uses to clone the application source. It needs Contents: read and write on only `HELM_chart_CD_ArgoCDproject`. Store the PAT as the **plain secret string** (rather than a JSON object) in AWS Secrets Manager in the **same account and region as CodeBuild**.

By default the CDK stack imports a secret named `taskboard/github-gitops-write-token`. To use a different name, add `-c gitopsTokenSecretName=YOUR_SECRET_NAME` to both `cdk diff` and `cdk deploy`. CDK grants the existing CodeBuild service role permission to read this secret and configures the `GITOPS_GITHUB_TOKEN` build environment variable as a Secrets Manager reference. The token value is not stored in Git or the CloudFormation template.

Check the secret's existence without printing its value:

```bash
aws secretsmanager describe-secret \
  --secret-id taskboard/github-gitops-write-token \
  --region ap-south-1 \
  --query '[Name,ARN]' --output table
```

## Review and deploy from WSL

Pull the latest CDK code, confirm the AWS account and region, then review the change before deploying:

```bash
git switch main
git pull --ff-only
aws sts get-caller-identity
npm ci
npm run build
npx cdk synth TaskboardCiStack
npx cdk diff TaskboardCiStack
npx cdk deploy TaskboardCiStack
```

Use `AWS_REGION=ap-south-1 AWS_DEFAULT_REGION=ap-south-1` if your AWS CLI/CDK default region differs. The existing project was deployed to account `606075279047` in `ap-south-1`; check the account identity before applying. The diff should update CodeBuild configuration and IAM permissions while leaving the ECR repositories in place.

If your secret has a different name, run these instead of the last two commands above:

```bash
npx cdk diff TaskboardCiStack -c gitopsTokenSecretName=YOUR_SECRET_NAME
npx cdk deploy TaskboardCiStack -c gitopsTokenSecretName=YOUR_SECRET_NAME
```

## Test the complete flow

The application repo already contains `scripts/publish_gitops.py` and `scripts/test_publish_gitops.py`. The GitOps chart already defines `web.image.tag`, `api.image.tag`, `redis.image.tag`, and `imagePullSecrets: [{name: ecr-pull}]`.

Start one build of the application repo's `main` after the CDK deployment:

```bash
aws codebuild start-build \
  --project-name taskboard-build-and-publish \
  --source-version main --region ap-south-1 \
  --query 'build.id' --output text
```

Copy the returned build ID and inspect its status/log URL:

```bash
aws codebuild batch-get-builds --ids YOUR_BUILD_ID --region ap-south-1 \
  --query 'builds[0].[buildStatus,logs.deepLink]' --output text
```

When the build succeeds, inspect the latest commit in the [GitOps repo](https://github.com/zawarvyankatesh/HELM_chart_CD_ArgoCDproject/commits/main), then check:

```bash
kubectl -n argocd get applications
kubectl -n taskboard get pods
kubectl -n taskboard get deployment taskboard-web taskboard-api \
  -o jsonpath='{range .items[*]}{.metadata.name}{": "}{.spec.template.spec.containers[0].image}{"\n"}{end}'
```

A push to the application repo's `main` should trigger future builds automatically through the existing CodeBuild webhook. If CodeBuild fails at `DOWNLOAD_SOURCE`, check the existing GitHub **source** credential. If it fails retrieving `GITOPS_GITHUB_TOKEN`, check the secret name, region, role permission, and secret format. If publishing returns HTTP 403, check that the PAT has Contents: read/write for the GitOps repo and has not expired.

The kind cluster must have the `ecr-pull` Secret in the `taskboard` namespace to pull private ECR images. Its ECR login token expires, so refresh that Kubernetes Secret when necessary. The CDK stack does not deploy into kind or refresh its image pull credentials.
