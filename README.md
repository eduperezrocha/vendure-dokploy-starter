[![Pinelab Logo](https://pinelab.studio/pinepas_smaller.png)](https://pinelab.studio)

# Vendure Dokploy Starter

This repository is a vanilla Vendure setup to deploy Vendure with Dokploy on a VPS: a Vendure API, worker instance, PostgreSQL and Redis with BullMQ as Job Queue.

Follow the steps below to get everything up and running on your VPS of choice.

![This is what the result should look like](https://raw.githubusercontent.com/Pinelab-studio/vendure-dokploy-starter/refs/heads/main/%20docs/dokploy-screenshot.png)

*These are the services we will be creating in Dokploy.*

## VPSgit

* Create a VPS with at least 4 GB of ram and a [supported Linux distro installed](https://docs.dokploy.com/docs/core/installation).

## Dokploy

* SSH in to your machine, [install Dokploy](https://docs.dokploy.com/docs/core/installation) and [complete the setup](https://docs.dokploy.com/docs/core/installation#completing-the-setup).
* Set up docker log rotation:
```bash
sudo su
nano /etc/docker/daemon.json

# Paste the following content and save the file
{
  "log-driver": "json-file",
  "log-opts": {
    "max-file": "3",
    "max-size": "100m"
  }
}
```
* Restart Docker with `service docker restart`.
* Log in to Dokploy and enable 2FA: Go to Profile, and then Enable 2fa in the top right corner.
* Create a new project named `Vendure`.

## PostgreSQL

* Create a new database and select `PostgreSQL`.
* Go to `External Credentials`, set the port to `5432` and click `Save` to expose the database to the internet. You should restrict access to this port to only allow your local IP address!
* Check if you can log in to the database from your local machine with `pgsql` or a tool like Beekeeper.

## Redis
* Create a new database and select `Redis`.
* Go to `External Credentials`, set the port to `6379` and click `Save` to expose the Redis instance to the internet. You should restrict access to this port to only allow your local IP address!

## Vendure API

This will be the main service that will be used to handle the API requests.

* Create a `.env` file in `./vendure/.env` and set the following variables:
```dotenv
PORT=3000
COOKIE_SECRET=Cookiesecret12321
SUPERADMIN_USERNAME=superadmin
SUPERADMIN_PASSWORD=superadmin
DB_HOST=vendure-postgres-erau4l # Get this from your Dokploy project
DB_PORT=5432
DB_NAME=vendure
DB_USERNAME=vendure
DB_PASSWORD=your-postgres-password
DB_SCHEMA=public
REDIS_PASSWORD=xyz12344
REDIS_HOST=vendure-redis-123456 # Get this from your Dokploy project
VENDURE_HOST=vendure.yourdomain.io

# Local overrides -- Don't copy these variables to Dokploy, they are just for running Vendure on your local machine
DB_HOST=12.123.12.123 # Your VPS IP address
REDIS_HOST=12.123.12.123
APP_ENV=local
```

* Run `npm ci` to install Vendure's dependencies.
* Run `npx vite build` to build the Vendure Dashboard.
* Run `npm run start:server` to start the Vendure API.
* Go to `http://localhost:3000/dashboard` to access the Vendure Dashboard.

If all is well, you should be able to log in. This means Vendure is configured correctly and it can reach the database and Redis.

#### Build Docker Image

* Copy the deploy webhooks for Vendure and the Vendure Worker applicatiuon from your Dokploy dashboard: Go to the `Deployments` tab and copy the webhook URL.
* Create an access token in your Docker Hub account and add set these variables as Github Action secrets in your repository:
```dotenv
DOCKERHUB_USERNAME=yourusername
DOCKERHUB_TOKEN=dckr_pat_xyz1243
DEPLOY_WEBHOOK_VENDURE_API=https://yourdokploy.io/api/deploy/auuuxJ5dnDOiKdaDJHA
DEPLOY_WEBHOOK_VENDURE_WORKER=https://yourdokploy.io/api/deploy/ajkldlkslKKLs
```
* Go to the `Actions` tab of your repository and enable GitHub Actions.
* Commit and push a change to the repository to trigger the Github Action that build the Docker image and push it to Docker Hub.
* Go to Docker Hub and verify that the image has been built and pushed.

#### Deploy the Image

* In Dokploy, create a new service named `Vendure API`.
* Under `Providers`, select `Docker` and fill in your image name, something like `yourusername/dokploy-vendure-demo:latest`.
* Copy the variables from the `.env` file from your repository, and paste them under Environment in the Vendure API application in Dokploy.
* Go to the `Advanced` tab.
* Create a volume and select Volume mount (not bind mount).
* Set `vendure_assets` as name, and `/usr/src/app/assets` as mount path and click `Save`.
* Click `Save` to deploy the service.
* Set the run command to `npm run start:server`
* Go back to the `General` tab and click `Deploy`.
* Set a custom domain for the service:
  * In your DNS provider, create an A record that points to the IP address of your VPS, e.g. `vendure.mydomain.com`
  * Only after setting the A record should you set the domain in Dokploy
* Go to `vendure.yourcustomdomain.io/dashboard` and verify that the Vendure Dashboard is accessible.
* From the Deployments tab, copy the webhook URL, and set it in your Github repository secrets as `DEPLOY_WEBHOOK_VENDURE_API`.
* Follow the steps in the [Dokploy Documentation](https://docs.dokploy.com/docs/core/applications/zero-downtime) and set the health check path to `/health`.

### Vendure Worker

Create a new service named `Vendure Worker` and repeat the same steps for the Vendure Worker, with a few exceptions:

* The run command should be `npm run start:worker`.
* Copy the deploy webhook again and set it in your Github Action secrets as `DEPLOY_WEBHOOK_VENDURE_WORKER`.
* Add the same volume mount with the same name and path.
* Set a custom domain for the worker.

## Resource limits

Set resource limits for each of the databases and services.

* Go to the Advanced tab
* Set memory limit to `1073741824` (1 GB)
* Set CPU limit to `1000000000` (1 CPU)

Example limits for a 4GB 2vCPU VPS:
| Service             | Memory Limit | CPU Limit |
|---------------------|---------|-----------|
| Vendure main API    | 1 GB    | None      |
| Vendure worker      | 0.5 GB  | 1 CPU     |
| Postgres            | 1 GB    | None      |
| Redis               | 0.5 GB  | 1 CPU     |

These are just sample values, and your values depend on the VPS and the resources you have available. **Make sure that the sum of all assigned memory never exceeds the total memory of your VPS.**

## Backups

* Create an S3 compatible destination in Dokploy. For example [Google Cloud Storage](https://docs.dokploy.com/docs/core/cloud-storage).
* Configurate automated backups for the PostgreSQL database: https://docs.dokploy.com/docs/core/databases/backups
* Configure volume backups for Vendure's assets: https://docs.dokploy.com/docs/core/volumes/backups. You only need to backup `vendure_assets` once for the Vendure API , not the worker.

## Load Testing

* See [Load Testing](load-test/README.md) for information and scripts to load test your setup.
* Indicative load: We have tested our 4 GB 2 vCPU instance to be capable of handling about 240 orders per minute before the p95 response time exceeds 500ms.

## Alerts and Notifications

* Use an uptime monitoring service to monitor `/health` for both the Vendure API and Worker.
* Set up resource monitoring with your VPS provider to alert you if the total memory or CPU usage exceeds the limits you have set.
* Alternatively, you can use the `DokployHealthCheckStrategy` to include CPU, memory and disk usage in the health check:

```ts
import { DokployHealthCheckStrategy } from './dokploy-health-strategy';

const vendureConfig = {
  systemOptions: {
    healthChecks: [
      new DokployHealthCheckStrategy({
        maxDiskPercent: 70,
        maxCpuPercent: 80,
        maxMemoryPercent: 70,
        apiKey: process.env.DOKPLOY_APIKEY, // Get this from your Dokploy project
        dokployHost: process.env.DOKPLOY_HOST, // E.g. "dokploy.mydomain.com" (without https:// and trailing slash)
      }),
    ],
  },
}

```
