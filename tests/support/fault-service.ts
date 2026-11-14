export const faultMongoUri =
  process.env.FAULT_MONGODB_URI ??
  "mongodb://127.0.0.1:27028/?replicaSet=rs0&directConnection=true";
const address = new URL(faultMongoUri);
if (
  !["127.0.0.1", "localhost"].includes(address.hostname) ||
  address.port !== "27028"
) {
  throw new Error(
    "Fault commands require the isolated loopback test service on port 27028",
  );
}
