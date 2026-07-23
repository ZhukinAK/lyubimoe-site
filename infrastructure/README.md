# Yandex Cloud deployment

The configuration creates the production YDB database, private gallery bucket,
Cloud Function, API Gateway, service account and managed certificate. Keep
`terraform.tfstate`, `*.tfvars`, static S3 keys and the function archive outside
Git.

## Prerequisites

1. An active Yandex Cloud billing account and a dedicated folder named
   `lyubimoe-production`.
2. Terraform and the Yandex Cloud CLI authenticated as the owner.
3. An encrypted, access-controlled location for Terraform state. To keep the
   initial monthly cost near zero, Terraform passes the bucket-restricted S3
   key through encrypted Cloud Function environment settings instead of
   Lockbox. The key is still present in sensitive Terraform state and must
   never be committed. Lockbox can be added later without migrating data.
4. A production function archive built from `backend/` with production
   dependencies included.

## Order

1. Run `terraform init` and `terraform plan -var-file=production.tfvars`.
2. Apply the plan only after reviewing estimated chargeable resources.
3. Add the Certificate Manager DNS challenge returned in
   `certificate_challenges` to REG.RU and wait for `ISSUED`.
4. Add `api.bibizana-chi.ru` as a CNAME to the value in
   `api_gateway_domain`.
5. Apply `backend/schema.yql` to YDB, then run the admin bootstrap script.
6. Run API smoke tests before changing the frontend configuration.

Billing notifications at 100 and 300 RUB are configured in Yandex Cloud Billing,
not by the Terraform provider. The bucket and YDB storage limits are the hard
cost guardrails in this configuration.
