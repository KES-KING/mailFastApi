import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  scenarios: {
    send_load: {
      executor: "ramping-arrival-rate",
      startRate: Number(__ENV.START_RATE || 5),
      timeUnit: "1s",
      preAllocatedVUs: Number(__ENV.PRE_ALLOCATED_VUS || 20),
      maxVUs: Number(__ENV.MAX_VUS || 200),
      stages: [
        { target: Number(__ENV.TARGET_RATE || 25), duration: __ENV.RAMP_DURATION || "1m" },
        { target: Number(__ENV.TARGET_RATE || 25), duration: __ENV.HOLD_DURATION || "3m" },
        { target: 0, duration: __ENV.RAMP_DOWN_DURATION || "30s" },
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500"],
  },
};

export function setup() {
  const baseUrl = __ENV.BASE_URL || "http://127.0.0.1:3000";
  const tokenResponse = http.post(
    `${baseUrl}/auth/token`,
    JSON.stringify({
      clientId: __ENV.CLIENT_ID || "webapp-default",
      clientSecret: __ENV.CLIENT_SECRET || "change_me_client_secret",
    }),
    { headers: { "content-type": "application/json" } },
  );

  check(tokenResponse, {
    "token status is 200": (response) => response.status === 200,
    "token exists": (response) => Boolean(response.json("access_token")),
  });

  return {
    baseUrl,
    token: tokenResponse.json("access_token"),
    tenantId: __ENV.TENANT_ID || "load_test",
  };
}

export default function sendMail(data) {
  const id = `${__VU}-${__ITER}-${Date.now()}`;
  const response = http.post(
    `${data.baseUrl}/send`,
    JSON.stringify({
      tenantId: data.tenantId,
      category: __ENV.MAIL_CATEGORY || "transactional",
      to: __ENV.TEST_TO || `load-${id}@example.com`,
      subject: `Load test ${id}`,
      html: `<p>Load test ${id}</p>`,
    }),
    {
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${data.token}`,
        "idempotency-key": id,
      },
    },
  );

  check(response, {
    "send status is 202": (nextResponse) => nextResponse.status === 202,
  });
  sleep(Number(__ENV.SLEEP_SECONDS || 0));
}
