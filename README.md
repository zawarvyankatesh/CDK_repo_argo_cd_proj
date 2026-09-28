# Taskboard CI with CDK

This CDK app deploys a CodeBuild project and three private ECR repositories. CodeBuild checks the frontend/backend source, builds both Docker images, mirrors the official `redis:7-alpine` image, and pushes all three to ECR. After verifying those images in ECR, it commits their references to `charts/taskboard/values.yaml` in [the GitOps repo](https://github.com/zawarvyankatesh/HELM_chart_CD_ArgoCDproject). A GitHub webhook runs it whenever `main` is pushed in `zawarvyankatesh/application_code_argocd_project`. Argo CD in your cluster watches the GitOps repo and deploys that commit.

## Plan and prerequisites

1. Pick the AWS region where you will later create EKS. Check that `aws sts get-caller-identity` returns your intended account.
2. Register GitHub source credentials **once** through the AWS CLI. AWS credentials authorize AWS but cannot authenticate CodeBuild to GitHub or install its webhook. Create a **fine-grained GitHub PAT** limited to `application_code_argocd_project` with Contents read, Commit statuses read/write, and Webhooks read/write permissions; do not add it to Git or CDK context. An existing CodeBuild GitHub source credential in the same region also works, so skip the import if you already have one.
3. Bootstrap the account/region from the CLI. CDK creates its standard bootstrap S3 bucket and roles; this stack does not require its own S3 bucket because images are stored in ECR and the BuildSpec is inline.
4. Deploy the stack. Start one build manually to test the current app commit. Subsequent pushes to the app repo's `main` trigger the webhook automatically.

## Allow CodeBuild to update the separate GitOps repository

Keep the existing GitHub source credential above for the application repository. Separately, create a **fine-grained GitHub personal access token** restricted to only `zawarvyankatesh/HELM_chart_CD_ArgoCDproject` with **Contents: Read and write**. It does not need webhook or administration permission. Store it as a plain-text secret value (not JSON) named `taskboard/github-gitops-write-token` in **the same AWS account and Region as CodeBuild**. Do not store or print it in Git, CDK context, or a CodeBuild plaintext variable.

For example, create the secret through AWS CLI after creating the token in GitHub. The token is read without echo and passed on standard input, avoiding a literal token in your shell history:

```bash
read -rsp 'GitOps repo GitHub token: ' TASKBOARD_GITOPS_PAT; echo
printf %s "$TASKBOARD_GITOPS_PAT" | aws secretsmanager create-secret \
  --name taskboard/github-gitops-write-token \
  --secret-string file:///dev/stdin \
  --region ap-south-1 \
  --query '[ARN,Name]' --output text
unset TASKBOARD_GITOPS_PAT
```

If the secret already exists, update it with `aws secretsmanager put-secret-value --secret-id taskboard/github-gitops-write-token --secret-string file:///dev/stdin --region ap-south-1` using the same `read` and `printf` method. The CDK stack imports this existing secret, grants its CodeBuild role read access, and injects it via CodeBuild's `SECRETS_MANAGER` variable type. The token is used only for the GitHub Contents API. CodeBuild checks that its source SHA is still `main` before updating GitOps, and GitHub rejects the write if someone changed `values.yaml` concurrently. Concurrent builds for this project are limited to one.

**Before deploying this CDK update**, confirm the GitOps repo already has `imagePullSecrets: [{name: ecr-pull}]` and the `ecr-pull` Secret exists in your kind `taskboard` namespace. Your manual ECR release should already have both. The short-lived ECR pull token in kind still needs refreshing for future pulls; updating Git does not refresh it.

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

## Deploy and test the GitOps publisher

After the GitHub token is in Secrets Manager, pull **both** the CDK and application repositories so the buildspec change and `scripts/publish_gitops.py` are present. Deploy the updated stack:

```bash
npm ci
npm run build
npx cdk diff TaskboardCiStack
npx cdk deploy TaskboardCiStack
```

Start a build of the current application `main` after deploying this stack; this also works when its immutable images were already pushed by an earlier build. A successful build verifies both images and the Redis mirror before committing a change to the **GitOps** repo's `main`; Argo CD sees that commit and updates the web/API Pods. Subsequent application commits trigger the same flow automatically through the existing webhook.

```bash
aws codebuild start-build --project-name taskboard-build-and-publish \
  --source-version main --region ap-south-1 \
  --query 'build.id' --output text
```

To inspect the flow:

```bash
aws codebuild list-builds-for-project --project-name taskboard-build-and-publish --region ap-south-1 --max-items 3
aws ecr describe-images --repository-name taskboard-web --region ap-south-1 --query 'imageDetails[].imageTags'
kubectl -n argocd get application taskboard
kubectl -n taskboard get pods
```

Builds of an already deployed SHA skip the GitOps commit; builds that are no longer the application repo's `main` also skip promotion. If the token expires or the GitOps file changes concurrently, CodeBuild reports the promotion as a failed build, leaving the last successful GitOps revision in place. The build does not access Kubernetes or Argo CD credentials.

`RETAIN` protects the repositories and images if the CDK stack is deleted. ECR image storage, CodeBuild builds, logs, CDK bootstrap resources, and Secrets Manager may incur AWS charges.
