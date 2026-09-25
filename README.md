# Taskboard CI with CDK

This CDK app deploys a CodeBuild project and three private ECR repositories. CodeBuild checks the frontend/backend source, builds both Docker images, mirrors the official `redis:7-alpine` image, and pushes all three to ECR. A GitHub webhook runs it whenever `main` is pushed in `zawarvyankatesh/application_code_argocd_project`. Nothing in this stack changes your kind cluster or deploys Helm/Argo CD.

## Plan and prerequisites

1. Pick the AWS region where you will later create EKS. Check that `aws sts get-caller-identity` returns your intended account.
2. Register GitHub source credentials **once** through the AWS CLI. AWS credentials authorize AWS but cannot authenticate CodeBuild to GitHub or install its webhook. Create a **fine-grained GitHub PAT** limited to `application_code_argocd_project` with Contents read, Commit statuses read/write, and Webhooks read/write permissions; do not add it to Git or CDK context. An existing CodeBuild GitHub source credential in the same region also works, so skip the import if you already have one.
3. Bootstrap the account/region from the CLI. CDK creates its standard bootstrap S3 bucket and roles; this stack does not require its own S3 bucket because images are stored in ECR and the BuildSpec is inline.
4. Deploy the stack. Start one build manually to test the current app commit. Subsequent pushes to the app repo's `main` trigger the webhook automatically.

## Set up from a terminal

From this repository directory (replace `ap-south-1` with your intended region):

```bash
export AWS_REGION=ap-south-1
export AWS_DEFAULT_REGION="$AWS_REGION"
aws sts get-caller-identity
npm ci
npm run build
npx cdk synth
```

If CodeBuild does not already have GitHub credentials in this **account and region**, import them before deployment. The following reads the token without echoing it into your terminal or saving it in this repository:

```bash
read -rsp 'GitHub PAT: ' GITHUB_PAT; echo
aws codebuild import-source-credentials \
  --server-type GITHUB \
  --auth-type PERSONAL_ACCESS_TOKEN \
  --token "$GITHUB_PAT"
unset GITHUB_PAT
aws codebuild list-source-credentials
```

Then bootstrap and deploy:

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
npx cdk bootstrap "aws://$ACCOUNT_ID/$AWS_REGION"
npx cdk diff
npx cdk deploy TaskboardCiStack
```

The output includes the CodeBuild project name and three ECR repository URIs. The source webhook is filtered to `refs/heads/main` and does not build pull requests or changes to this CDK repository.

## Run and check the first build

```bash
BUILD_ID=$(aws codebuild start-build \
  --project-name taskboard-build-and-publish \
  --query 'build.id' --output text)
echo "$BUILD_ID"
aws codebuild batch-get-builds --ids "$BUILD_ID" \
  --query 'builds[0].[buildStatus,logs.deepLink]' --output text
aws ecr describe-images --repository-name taskboard-web --query 'imageDetails[].imageTags'
aws ecr describe-images --repository-name taskboard-api --query 'imageDetails[].imageTags'
aws ecr describe-images --repository-name taskboard-redis --query 'imageDetails[].imageTags'
```

Poll `batch-get-builds` until status is `SUCCEEDED`. If it fails, open the returned CloudWatch log link or use `aws logs` to read the build log. Web and API images use the first 12 characters of the Git commit SHA. Their ECR tags are immutable; retrying the same commit skips pushing a tag that already exists. The Redis mirror uses a mutable `7-alpine` tag, refreshed on each build. A future Helm chart should point to these ECR URIs. Mirroring Redis makes the Kubernetes nodes pull it from ECR, though **CodeBuild still pulls the upstream image from Docker Hub** at build time.

`RETAIN` protects the repositories and images if the CDK stack is deleted. ECR image storage, CodeBuild builds, logs, and CDK bootstrap resources may incur AWS charges.
