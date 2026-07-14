const worker = new Worker("./physics-worker.mjs", { type: "module" });
const status = document.querySelector("[data-status]");
const output = document.querySelector("[data-output]");
const buttons = [...document.querySelectorAll("button[data-kind]")];
let nextRequestId = 1;

function setBusy(busy) {
  for (const button of buttons) button.disabled = busy;
}

function showResult(result) {
  output.replaceChildren(
    ...Object.entries(result.metrics).map(([name, value]) => {
      const row = document.createElement("tr");
      const passed = value <= result.limits[name];
      row.innerHTML = `<th scope="row">${name}</th><td>${value.toExponential(6)}</td><td>${result.limits[name].toExponential(1)}</td><td class="${passed ? "pass" : "fail"}">${passed ? "通过" : "失败"}</td>`;
      return row;
    }),
  );
  status.textContent = result.passed ? "验收通过" : result.failures.join("; ");
  status.dataset.state = result.passed ? "pass" : "fail";
}

function run(kind) {
  setBusy(true);
  status.textContent = kind === "long" ? "正在运行 1000 周期验收..." : "正在运行一周期验收...";
  status.dataset.state = "running";
  worker.postMessage({ requestId: nextRequestId++, kind });
}

worker.addEventListener("message", (event) => {
  if (event.data.type === "ready") {
    status.textContent = "Worker 已就绪";
    run("one-period");
  } else if (event.data.type === "result") {
    setBusy(false);
    showResult(event.data.result);
  } else if (event.data.type === "error") {
    setBusy(false);
    status.textContent = event.data.message;
    status.dataset.state = "fail";
  }
});

worker.addEventListener("error", (event) => {
  setBusy(false);
  status.textContent = event.message;
  status.dataset.state = "fail";
});

for (const button of buttons) {
  button.addEventListener("click", () => run(button.dataset.kind));
}
