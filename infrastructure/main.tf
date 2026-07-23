resource "yandex_iam_service_account" "api" {
  name        = "lyubimoe-api"
  description = "Runtime identity for the Lyubimoe API"
}

resource "yandex_iam_service_account_static_access_key" "api_storage" {
  service_account_id = yandex_iam_service_account.api.id
  description        = "Restricted key for the private gallery bucket"
}

resource "yandex_ydb_database_serverless" "main" {
  name                = "lyubimoe-production"
  deletion_protection = true
  serverless_database {
    storage_size_limit = 2
  }
}

resource "yandex_ydb_database_iam_binding" "api_editor" {
  database_id = yandex_ydb_database_serverless.main.id
  role        = "ydb.editor"
  members     = ["serviceAccount:${yandex_iam_service_account.api.id}"]
}

resource "yandex_storage_bucket" "gallery" {
  folder_id = var.folder_id
  bucket    = "lyubimoe-gallery-production"
  max_size  = 2 * 1024 * 1024 * 1024

  anonymous_access_flags {
    read        = false
    list        = false
    config_read = false
  }

  cors_rule {
    allowed_methods = ["GET", "PUT", "HEAD"]
    allowed_origins = var.allowed_origins
    allowed_headers = ["content-type"]
    expose_headers  = ["etag"]
    max_age_seconds = 3600
  }

  lifecycle_rule {
    id                                     = "abort-incomplete-uploads"
    enabled                                = true
    abort_incomplete_multipart_upload_days = 1
  }

  versioning { enabled = false }
}

resource "yandex_storage_bucket_iam_binding" "api_editor" {
  bucket  = yandex_storage_bucket.gallery.bucket
  role    = "storage.editor"
  members = ["serviceAccount:${yandex_iam_service_account.api.id}"]
}

resource "yandex_function" "api" {
  name               = "lyubimoe-api"
  description        = "Private API for gallery, memories and future games"
  user_hash          = filesha256(var.function_zip)
  runtime            = "nodejs22"
  entrypoint         = "src/index.handler"
  memory             = 256
  execution_timeout  = "15"
  service_account_id = yandex_iam_service_account.api.id
  content { zip_filename = var.function_zip }
  environment = {
    YDB_ENDPOINT         = yandex_ydb_database_serverless.main.ydb_api_endpoint
    YDB_DATABASE         = yandex_ydb_database_serverless.main.database_path
    S3_BUCKET            = yandex_storage_bucket.gallery.bucket
    S3_ACCESS_KEY_ID     = yandex_iam_service_account_static_access_key.api_storage.access_key
    S3_SECRET_ACCESS_KEY = yandex_iam_service_account_static_access_key.api_storage.secret_key
    ALLOWED_ORIGINS      = join(",", var.allowed_origins)
    COOKIE_DOMAIN        = ".bibizana-chi.ru"
    ROOM_SLUG            = "preview"
  }
}

resource "yandex_function_iam_binding" "gateway_invoker" {
  function_id = yandex_function.api.id
  role        = "functions.functionInvoker"
  members     = ["serviceAccount:${yandex_iam_service_account.api.id}"]
}

resource "yandex_function_trigger" "pending_upload_cleanup" {
  name        = "lyubimoe-pending-upload-cleanup"
  description = "Remove gallery uploads not completed within 24 hours"
  function {
    id                 = yandex_function.api.id
    service_account_id = yandex_iam_service_account.api.id
    retry_attempts     = "2"
    retry_interval     = "30"
  }
  timer {
    cron_expression = "15 3 ? * * *"
    payload         = jsonencode({ action = "cleanup-pending" })
  }
  depends_on = [yandex_function_iam_binding.gateway_invoker]
}

resource "yandex_cm_certificate" "api" {
  name    = "lyubimoe-api"
  domains = [var.api_domain]
  managed { challenge_type = "DNS_CNAME" }
}

resource "yandex_api_gateway" "api" {
  name = "lyubimoe-api"
  custom_domains {
    fqdn           = var.api_domain
    certificate_id = yandex_cm_certificate.api.id
  }
  spec = yamlencode({
    openapi = "3.0.0"
    info    = { title = "Lyubimoe API", version = "1.0.0" }
    paths = {
      "/{proxy+}" = {
        parameters = [{ name = "proxy", in = "path", required = false, schema = { type = "string" } }]
        "x-yc-apigateway-any-method" = {
          "x-yc-apigateway-integration" = {
            type               = "cloud_functions"
            function_id        = yandex_function.api.id
            service_account_id = yandex_iam_service_account.api.id
          }
        }
      }
    }
  })
}
