output "api_gateway_domain" { value = yandex_api_gateway.api.domain }
output "certificate_challenges" { value = yandex_cm_certificate.api.challenges }
output "ydb_endpoint" { value = yandex_ydb_database_serverless.main.ydb_full_endpoint }
output "api_domain" { value = var.api_domain }
