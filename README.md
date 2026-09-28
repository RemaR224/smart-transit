# Smart Transit: Real-Time Delay Prediction and Crowd Management

SIT314 Software Architecture and Scalability for IoT, Deakin University, T2 2026
Rema Ramesh (223904119)

Simulated buses and V/Line trains send live location, speed and occupancy data to
AWS IoT Core. An AWS Lambda function predicts how late each vehicle will be at its
next stop, classifies how crowded it is, stores the results in DynamoDB and sends
alerts. A web dashboard shows the whole network live.

## Routes

| Route | Corridor | Type |
|---|---|---|
| route-888 | Cranbourne Station to Dandenong Station | bus |
| route-857 | Frankston Station to Dandenong Station | bus |
| vline-traralgon | Dandenong to Traralgon | train |
| vline-ballarat | Southern Cross to Ballarat | train |

## How it works

1. `simulator.js` publishes one message per vehicle over MQTT (TLS, X.509 certificate)
   to `transit/<route>/vehicle/<id>/telemetry`.
2. The IoT Rule `transit_to_lambda` sends every message to the Lambda function
   `transit-processor` (`processing/index.mjs`).
3. Lambda smooths speed and occupancy, predicts the delay, sets the crowd level and
   writes to DynamoDB (`TransitVehicleState` and `TransitTelemetry`).
4. Major delays and full vehicles are published to `transit/alerts/<route>`.
5. `dashboard/server.js` shows the map, alerts and vehicle tables at http://localhost:3000.

`baseline/baseline-processor.mjs` is the single-server version used for the
before-scaling load test. It runs the same processing code on one EC2 instance.

## Folders

| Path | Contents |
|---|---|
| `simulator.js`, `route.js` | Vehicle simulator and routes |
| `processing/` | Lambda function code |
| `baseline/` | Single-server processor |
| `dashboard/` | Dashboard server and web page |
| `analysis/` | Load-test analysis and chart scripts |
| `results/` | Load-test results and charts |
| `test/` | Simulator test and processing unit tests |

## Running

```bash
npm install
npm test
npm run test:processing

node simulator.js --vehicles=20 --interval=5000 \
  --broker=mqtts://<iot-endpoint>:8883 \
  --cert=certs/device.cert.pem --key=certs/device.private.key --ca=certs/AmazonRootCA1.pem

npm run dashboard
```

Certificates go in `certs/` and are not included in this repository.

## Results

Each test sent 1 message per vehicle per second for 2 minutes.

| Vehicles | Single server | AWS Lambda |
|---|---|---|
| 100 | 97 msg/s, 0% lost, p95 1.61 s | 98 msg/s, 0.02% lost, p95 1.03 s |
| 200 | 103 msg/s, 47.2% lost, p95 3.68 s | 195 msg/s, 0% lost, p95 1.11 s |

Full results are in `results/summary.csv`.
