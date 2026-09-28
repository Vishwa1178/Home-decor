const http = require("http");
const fs = require("fs");
const path = require("path");

const port = Number(process.env.PORT || 5173);
const host = process.env.HOST || "127.0.0.1";
const root = path.resolve(__dirname);
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml"
};

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
};

const server = http.createServer((request, response) => {
  if (!["GET", "HEAD"].includes(request.method)) {
    response.writeHead(405, { ...securityHeaders, Allow: "GET, HEAD" });
    response.end("Method not allowed");
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === "/health") {
    send(response, 200, "ok", "text/plain; charset=utf-8");
    return;
  }

  let filePath = path.resolve(root, `.${pathname}`);

  if (pathname === "/" || pathname === "/admin") {
    filePath = path.join(root, "index.html");
  }

  if (!filePath.startsWith(`${root}${path.sep}`) && filePath !== path.join(root, "index.html")) {
    send(response, 403, "Forbidden", "text/plain; charset=utf-8");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (path.extname(filePath)) {
        send(response, 404, "Not found", "text/plain; charset=utf-8");
        return;
      }

      fs.readFile(path.join(root, "index.html"), (fallbackError, fallback) => {
        if (fallbackError) {
          send(response, 404, "Not found", "text/plain; charset=utf-8");
          return;
        }
        send(response, 200, fallback, mimeTypes[".html"]);
      });
      return;
    }

    send(response, 200, content, mimeTypes[path.extname(filePath)] || "application/octet-stream", filePath);
  });
});

function send(response, statusCode, body, contentType, filePath = "") {
  const isAsset = filePath && path.extname(filePath) && !filePath.endsWith(".html");
  response.writeHead(statusCode, {
    ...securityHeaders,
    "Content-Type": contentType,
    "Cache-Control": isAsset ? "no-cache" : "no-store"
  });
  if (response.req?.method === "HEAD") {
    response.end();
    return;
  }
  response.end(body);
}

server.listen(port, host, () => {
  console.log(`Home Decor site running at http://${host}:${port}`);
  console.log("Use PORT=8080 HOST=0.0.0.0 npm start for deployment-style hosting.");
});
