variable "cloud_id" { type = string }
variable "folder_id" { type = string }
variable "function_zip" {
  type        = string
  description = "Absolute path to the deployable backend zip including production node_modules."
}
variable "api_domain" {
  type    = string
  default = "api.bibizana-chi.ru"
}
variable "allowed_origins" {
  type    = list(string)
  default = ["https://bibizana-chi.ru", "https://www.bibizana-chi.ru"]
}
