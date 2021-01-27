const BbPromise = require('bluebird');
const { spawnSync } = require('child_process');
const _ = require('lodash');
const fse = require('fs-extra');
const path = require('path');
const util = require('util');
const { getDockerLoginToECRCommand } = require('./awscli');

/**
 * @returns {string} "<ECR Repo Name>:default" or custom tagged
 */
function getDockerImageName(customTag) {
  if (customTag) {
    return `${this.provider.naming.getECRRepositoryURL()}:${customTag}`;
  }
  return `${this.provider.naming.getECRRepositoryURL()}:default`;
}

/**
 * Helper function to run a docker command
 * @param {string[]} options
 * @param {string} cwd Current working directory
 * @return {Object}
 */
function dockerCommand(options, cwd = null, stdio = null) {
  const cmd = 'docker';
  var spawnOptions = {
    encoding: 'utf-8',
  };
  if (cwd != null) {
    spawnOptions.cwd = cwd;
  }
  if (stdio != null) {
    spawnOptions.stdio = stdio;
  }

  const ps = spawnSync(cmd, options, spawnOptions);
  if (ps.error) {
    if (ps.error.code === 'ENOENT') {
      throw new Error('docker not found! Please install it.');
    }
    throw new Error(ps.error);
  } else if (ps.status !== 0) {
    throw new Error(ps.stderr);
  }
  return ps;
}

/**
 * Build the custom Docker image by copying our package to the /var/task directory
 * in the docker image.
 *
 * Our base image uses the Lambda Docker Image for the platform:
 * https://hub.docker.com/r/lambci/lambda/
 */
function buildDockerImages() {
  // getting list of all images we will build
  let imagesNameTags = ['default'];
  if (
    this.serverless.service.custom &&
    this.serverless.service.custom.awsBatch &&
    this.serverless.service.custom.awsBatch.customDockerfiles
  ) {
    imagesNameTags = imagesNameTags.concat(
      Object.keys(this.serverless.service.custom.awsBatch.customDockerfiles)
    );
  }

  // preparing artifacts for images
  const servicePath = this.serverless.config.servicePath || '';
  const packagePath = path.join(servicePath || '.', '.serverless');
  const tmpPath = path.join(packagePath || '.', 'tmp');

  _.forEach(this.serverless.service.functions, (fn) => {
    if (!fn.hasOwnProperty('batch')) {
      return;
    }
    const name = fn.name.split('-').slice(-1)[0];
    const fileName = `${name}.zip`;

    if (!fse.pathExistsSync(packagePath)) {
      fse.mkdirSync(packagePath);
    }

    if (!fse.pathExistsSync(tmpPath)) {
      fse.mkdirSync(tmpPath);
    }

    fse.copyFileSync(
      path.join(packagePath, fileName),
      path.join(tmpPath, fileName)
    );
  });

  // generating images
  for (const imageNameTag of imagesNameTags) {
    this.serverless.cli.log(
      `Building docker image: "${this.provider.naming.getDockerImageName(
        imageNameTag
      )}"...`
    );
    let dockerfileContents;
    if (imageNameTag === 'default') {
      dockerfileContents = getDefaultDockerfileContent.bind(this)();
    } else {
      dockerfileContents = getCustomDockerfileContent.bind(this)(imageNameTag);
    }
    const dockerFile = path.join(tmpPath, `${imageNameTag}.Dockerfile`);
    fse.writeFileSync(dockerFile, dockerfileContents);
    const dockerOptions = [
      'build',
      '-f',
      dockerFile,
      '-t',
      this.provider.naming.getDockerImageName(imageNameTag),
      tmpPath,
    ];
    dockerCommand(dockerOptions, packagePath, 'inherit');
  }

  // resolve
  return BbPromise.resolve();
}

function getCustomDockerfileContent(imageNameTag) {
  let dockerfileContents = fse.readFileSync(
    this.serverless.service.custom.awsBatch.customDockerfiles[imageNameTag],
    'utf8'
  );
  let subContent = '';

  _.forEach(this.serverless.service.functions, (fn) => {
    if (!fn.hasOwnProperty('batch')) {
      return;
    }
    const fileName = `${fn.name.split('-').slice(-1)[0]}.zip`;
    subContent = subContent.concat(`
        COPY ${fileName} /tmp
        RUN cd /tmp && unzip -q ${fileName} && rm ${fileName}
        RUN echo '\\nconst event = JSON.parse(process.argv[2])\\nconst functionName = process.env.BATCH_LAMBDA_NAME\\nmodule.exports.default(event, {functionName: functionName}).then((res)=>{process.exit(0)}).catch((err)=>{process.exit(1)})' >> /tmp/${
          fn.handler.split('.')[0]
        }.js
      `);
  });
  subContent = subContent.concat(
    `RUN cp -R /tmp /var/task/${this.serverless.service.service}\n`
  );

  dockerfileContents = dockerfileContents.replace(
    '###PLACEHOLDER-FOR-GENERATED-CONTENT###',
    subContent
  );

  return dockerfileContents;
}

function getDefaultDockerfileContent() {
  let additionalRunCommands = '';
  if (
    this.serverless.service.custom &&
    this.serverless.service.custom.awsBatch &&
    this.serverless.service.custom.awsBatch.additionalDockerRunCommands
  ) {
    _.forEach(
      this.serverless.service.custom.awsBatch.additionalDockerRunCommands,
      (runCommand) => {
        additionalRunCommands += `RUN ${runCommand}\n`;
      }
    );
  }

  let dockerfileContents = `
    FROM justinram11/lambda:build-${this.serverless.service.provider.runtime} AS builder
    ${additionalRunCommands}
  `;

  _.forEach(this.serverless.service.functions, (fn) => {
    if (!fn.hasOwnProperty('batch')) {
      return;
    }
    const fileName = `${fn.name.split('-').slice(-1)[0]}.zip`;
    dockerfileContents = dockerfileContents.concat(`
        COPY ${fileName} /tmp
        RUN cd /tmp && unzip -q ${fileName} && rm ${fileName}
      `);
  });

  dockerfileContents = dockerfileContents.concat(`
    FROM justinram11/lambda:${this.serverless.service.provider.runtime}
    COPY --from=builder /tmp /var/task/${this.serverless.service.service}/
    RUN rm -rf /tmp/*
  `);
  if (this.serverless.service.provider.runtime === 'nodejs10.x') {
    dockerfileContents = dockerfileContents.concat(
      'ENV NODE_OPTIONS="--max-old-space-size=30000"\n'
    );
  }

  return dockerfileContents;
}

/**
 * Uses docker to upload the image to ECR
 */
function pushDockerImagesToECR() {
  // Log docker into our AWS ECR repo so that we can push images to it
  this.serverless.cli.log('Logging into ECR...');
  const loginCommand = getDockerLoginToECRCommand.bind(this)();
  dockerCommand(loginCommand.split(' '));

  // Then perform the upload
  this.serverless.cli.log('Uploading to ECR...');
  dockerCommand(
    ['push', this.provider.naming.getECRRepositoryURL(), '--all-tags'],
    null,
    'inherit'
  );

  return BbPromise.resolve();
}

module.exports = {
  getDockerImageName,
  buildDockerImages,
  pushDockerImagesToECR,
};
