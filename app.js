import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- Map ----------
const map = L.map("map").setView([35.6892, 51.389], 12); // تهران
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "© OpenStreetMap",
}).addTo(map);

const markers = {}; // { userId: { marker, name } }

// ---------- Elements ----------
const statusEl = document.getElementById("status");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const userNameInput = document.getElementById("userName");
const userList = document.getElementById("userList");

// ---------- State ----------
let watchId = null;
let myId = localStorage.getItem("tracker_id") || crypto.randomUUID();
localStorage.setItem("tracker_id", myId);

// ---------- Position updates ----------
async function updatePosition(pos) {
  const { latitude: lat, longitude: lng, accuracy } = pos.coords;
  const name = userNameInput.value.trim() || "ناشناس";

  // موقعیت خودم روی نقشه
  showMarker(myId, lat, lng, name, true);

  const { error } = await supabase.from("trackers").upsert(
    {
      id: myId,
      user_name: name,
      lat,
      lng,
      accuracy,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" }
  );

  if (error) console.error("خطا در ارسال:", error);
}

function showMarker(id, lat, lng, name, isMe = false) {
  if (markers[id]) {
    markers[id].marker.setLatLng([lat, lng]);
    markers[id].name = name;
  } else {
    const color = isMe ? "red" : "blue";
    const icon = L.divIcon({
      className: "custom-marker",
      html: `<div style="background:${color};width:16px;height:16px;border-radius:50%;border:3px solid white;box-shadow:0 0 8px ${color};"></div>`,
      iconSize: [16, 16],
    });
    const marker = L.marker([lat, lng], { icon }).addTo(map).bindPopup(`<b>${name}</b>`);
    markers[id] = { marker, name };
  }
  renderUsers();
}

function renderUsers() {
  userList.innerHTML = "";
  Object.entries(markers).forEach(([id, data]) => {
    const li = document.createElement("li");
    li.textContent = `${id === myId ? "🟢 (شما) " : "🔵 "}${data.name}`;
    userList.appendChild(li);
  });
}

// ---------- Start / Stop ----------
startBtn.onclick = () => {
  if (!navigator.geolocation) return alert("مرورگر شما از GPS پشتیبانی نمی‌کند");

  watchId = navigator.geolocation.watchPosition(
    updatePosition,
    (err) => console.error(err),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
  );

  statusEl.textContent = "آنلاین";
  statusEl.classList.add("online");
  startBtn.disabled = true;
  stopBtn.disabled = false;
};

stopBtn.onclick = () => {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  statusEl.textContent = "آفلاین";
  statusEl.classList.remove("online");
  startBtn.disabled = false;
  stopBtn.disabled = true;
};

// ---------- Realtime ----------
supabase
  .channel("trackers-live")
  .on(
    "postgres_changes",
    { event: "*", schema: "public", table: "trackers" },
    (payload) => {
      const row = payload.new;
      if (!row || row.id === myId) return;
      showMarker(row.id, row.lat, row.lng, row.user_name);
    }
  )
  .subscribe();

// ---------- Load existing ----------
async function loadExisting() {
  const { data, error } = await supabase.from("trackers").select("*");
  if (error) return console.error(error);
  data.forEach((row) => {
    if (row.id !== myId) showMarker(row.id, row.lat, row.lng, row.user_name);
  });
}
loadExisting();

// ---------- Cleanup on leave ----------
window.addEventListener("beforeunload", async () => {
  await supabase.from("trackers").delete().eq("id", myId);
});