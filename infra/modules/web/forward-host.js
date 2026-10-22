// CloudFront Function (cloudfront-js-2.0), viewer request: keep the viewer's host for the origin.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function handler(event) {
  var request = event.request;
  if (request.headers.host) {
    request.headers["x-forwarded-host"] = { value: request.headers.host.value };
  }
  return request;
}
