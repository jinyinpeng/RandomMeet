(() => {
  const $ = id => document.getElementById(id);
  let token = "";
  async function loadReports() {
    if (!token) return;
    $("adminStatus").textContent = "Loading reports…";
    $("refreshReports").disabled = true;
    try {
      const response = await fetch("/admin/reports", { headers: { "x-admin-token": token }, cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not load reports.");
      const reports = Array.isArray(data.reports) ? data.reports : [];
      $("reportCount").textContent = reports.length + (reports.length === 1 ? " report" : " reports");
      const list = $("reportsList");
      list.replaceChildren();
      reports.forEach(report => {
        const card = document.createElement("article");
        card.className = "report-entry";
        const heading = document.createElement("h3");
        heading.textContent = (report.reason || "unknown").replaceAll("_", " ");
        const date = document.createElement("p");
        date.textContent = report.createdAt ? new Date(report.createdAt).toLocaleString() : "Unknown time";
        const ids = document.createElement("p");
        ids.textContent = "Report ID: " + (report.id || "n/a") + " · Reporter: " + (report.reporterId || "unknown") + " · Reported: " + (report.reportedId || "unknown");
        card.append(heading, date, ids);
        list.append(card);
      });
      $("adminStatus").textContent = data.note || "Reports loaded.";
    } catch (error) {
      $("adminStatus").textContent = error.message || "Could not load reports.";
    } finally {
      $("refreshReports").disabled = false;
    }
  }
  $("adminForm").addEventListener("submit", event => {
    event.preventDefault();
    token = $("adminToken").value.trim();
    void loadReports();
  });
  $("refreshReports").addEventListener("click", () => void loadReports());
})();