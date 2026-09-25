import * as cdk from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export class TaskboardCiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const web = new ecr.Repository(this, 'WebImages', {
      repositoryName: 'taskboard-web',
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const api = new ecr.Repository(this, 'ApiImages', {
      repositoryName: 'taskboard-api',
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    const redis = new ecr.Repository(this, 'RedisImages', {
      repositoryName: 'taskboard-redis',
      imageTagMutability: ecr.TagMutability.MUTABLE,
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // The build commands live here: the application repository only needs its
    // frontend/ and backend/ Dockerfiles. No extra S3 artifact bucket is needed.
    const buildSpec = codebuild.BuildSpec.fromObject({
      version: '0.2',
      phases: {
        install: {
          'runtime-versions': { python: '3.12', nodejs: '20' },
        },
        pre_build: {
          commands: [
            'export IMAGE_TAG="$(printf %s "$CODEBUILD_RESOLVED_SOURCE_VERSION" | cut -c1-12)"',
            'test -n "$IMAGE_TAG"',
            'aws ecr get-login-password --region "$AWS_DEFAULT_REGION" | docker login --username AWS --password-stdin "$ECR_REGISTRY"',
            'python3 -m py_compile backend/app.py',
            'node --check frontend/app.js',
          ],
        },
        build: {
          commands: [
            'docker build -t "$WEB_REPOSITORY_URI:$IMAGE_TAG" ./frontend',
            'docker build -t "$API_REPOSITORY_URI:$IMAGE_TAG" ./backend',
            'docker pull redis:7-alpine',
            'docker tag redis:7-alpine "$REDIS_REPOSITORY_URI:7-alpine"',
          ],
        },
        post_build: {
          commands: [
            'aws ecr describe-images --repository-name taskboard-web --image-ids imageTag="$IMAGE_TAG" >/dev/null 2>&1 || docker push "$WEB_REPOSITORY_URI:$IMAGE_TAG"',
            'aws ecr describe-images --repository-name taskboard-api --image-ids imageTag="$IMAGE_TAG" >/dev/null 2>&1 || docker push "$API_REPOSITORY_URI:$IMAGE_TAG"',
            'docker push "$REDIS_REPOSITORY_URI:7-alpine"',
            'echo "Published web and API tag $IMAGE_TAG, plus Redis tag 7-alpine"',
          ],
        },
      },
    });

    const project = new codebuild.Project(this, 'BuildAndPublish', {
      projectName: 'taskboard-build-and-publish',
      description: 'Builds web and API images and mirrors Redis to private ECR',
      source: codebuild.Source.gitHub({
        owner: 'zawarvyankatesh',
        repo: 'application_code_argocd_project',
        branchOrRef: 'main',
        webhook: true,
        webhookFilters: [
          codebuild.FilterGroup.inEventOf(codebuild.EventAction.PUSH)
            .andHeadRefIs('^refs/heads/main$'),
        ],
        reportBuildStatus: false,
      }),
      buildSpec,
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.SMALL,
        privileged: true,
        environmentVariables: {
          WEB_REPOSITORY_URI: { value: web.repositoryUri },
          API_REPOSITORY_URI: { value: api.repositoryUri },
          REDIS_REPOSITORY_URI: { value: redis.repositoryUri },
          ECR_REGISTRY: { value: `${this.account}.dkr.ecr.${this.region}.amazonaws.com` },
        },
      },
    });

    for (const repository of [web, api, redis]) {
      repository.grantPullPush(project);
    }
    project.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'], // ECR requires this token action at registry scope.
    }));
    project.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecr:DescribeImages'],
      resources: [web.repositoryArn, api.repositoryArn],
    }));

    new cdk.CfnOutput(this, 'ProjectName', { value: project.projectName });
    new cdk.CfnOutput(this, 'WebRepositoryUri', { value: web.repositoryUri });
    new cdk.CfnOutput(this, 'ApiRepositoryUri', { value: api.repositoryUri });
    new cdk.CfnOutput(this, 'RedisRepositoryUri', { value: redis.repositoryUri });
  }
}
