const response = await fetch("https://txline-dev.txodds.com/auth/guest/start", {
  method: "POST",
  headers: { accept: "application/json" }
});

if (!response.ok) {
  console.error(`TxLINE guest session failed: ${response.status} ${response.statusText}`);
  process.exit(1);
}

const body = await response.json();
if (!body.token) {
  console.error("TxLINE guest session response did not include token");
  console.error(JSON.stringify(body, null, 2));
  process.exit(1);
}

console.log(body.token);
