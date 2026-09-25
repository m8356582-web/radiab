
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

// اتصال به Supabase
const supabase = createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY
);

// دسترسی به عناصر صفحه
const $ = (id) => document.getElementById(id);

const statusEl = $("status");
const statusText = $("statusText");
const notice = $("notice");
const startBtn = $("startBtn");
const stopBtn = $("stopBtn");
const centerBtn = $("centerBtn");
const nameInput = $("userName");
const userList = $("userList");
const userCount = $("userCount");

// ساخت نقشه با مرکز تهران
const map = L.map("map").setView(
    [35.6892, 51.3890],
    12
);

L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap'
    }
).addTo(map);

// اطلاعات کاربران و نشانگرها
const markers = new Map();

let myId = localStorage.getItem("tracker_id");

if (!myId) {
    myId = crypto.randomUUID();
    localStorage.setItem("tracker_id", myId);
}

let watchId = null;
let lastPosition = null;
let sending = false;

// نمایش وضعیت اتصال
function setStatus(message, online = false) {
    statusText.textContent = message;
    statusEl.classList.toggle("online", online);
}

// نمایش پیام
function showNotice(message, type = "") {
    notice.textContent = message;
    notice.className = ("notice " + type).trim();
}

// دریافت نام نمایشی
function getUserName() {
    return nameInput.value
        .trim()
        .replace(/\s+/g, " ")
        .slice(0, 32) || "کاربر بی‌نام";
}

// محتوای امن پنجره نشانگر
function makePopup(name, isMe) {
    const element = document.createElement("div");
    const strong = document.createElement("strong");

    strong.textContent = name + (isMe ? " (شما)" : "");
    element.appendChild(strong);

    return element;
}

// نمایش یا به‌روزرسانی نشانگر
function showMarker(
    id,
    lat,
    lng,
    name,
    isMe = false,
    updatedAt = null
) {
    lat = Number(lat);
    lng = Number(lng);

    if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lng) ||
        lat < -90 || lat > 90 ||
        lng < -180 || lng > 180
    ) {
        return;
    }

    const safeName = String(name || "کاربر بی‌نام").slice(0, 32);
    const point = [lat, lng];

    let entry = markers.get(id);

    if (entry) {
        entry.marker.setLatLng(point);
        entry.marker.setPopupContent(
            makePopup(safeName, isMe)
        );
        entry.name = safeName;
        entry.updatedAt = updatedAt;
    } else {
        const marker = L.circleMarker(point, {
            radius: isMe ? 9 : 7,
            color: "#ffffff",
            weight: 2,
            fillColor: isMe ? "#ef626c" : "#5688f5",
            fillOpacity: 1
        }).addTo(map);

        marker.bindPopup(
            makePopup(safeName, isMe)
        );

        markers.set(id, {
            marker,
            name: safeName,
            updatedAt
        });
    }

    renderUsers();
}

// حذف نشانگر کاربر
function removeMarker(id) {
    const entry = markers.get(id);

    if (!entry) return;

    map.removeLayer(entry.marker);
    markers.delete(id);
    renderUsers();
}

// تبدیل زمان به ساعت فارسی
function formatTime(value) {
    if (!value) return "زمان نامشخص";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return "زمان نامشخص";
    }

    return "آخرین بروزرسانی: " +
        date.toLocaleTimeString("fa-IR", {
            hour: "2-digit",
            minute: "2-digit"
        });
}

// ساخت فهرست کاربران
function renderUsers() {
    userList.replaceChildren();

    const entries = [...markers.entries()].sort(
        (a, b) =>
            Number(b[0] === myId) - Number(a[0] === myId)
    );

    userCount.textContent =
        new Intl.NumberFormat("fa-IR").format(entries.length);

    if (entries.length === 0) {
        const li = document.createElement("li");
        li.className = "empty";
        li.textContent = "هنوز کاربری آنلاین نیست.";
        userList.appendChild(li);
        return;
    }

    for (const [id, data] of entries) {
        const li = document.createElement("li");
        li.className = "user-item";

        const avatar = document.createElement("span");
        avatar.className = "avatar" +
            (id === myId ? " me" : "");
        avatar.textContent = [...data.name][0] || "؟";

        const meta = document.createElement("div");
        meta.className = "user-meta";

        const name = document.createElement("div");
        name.className = "user-name";
        name.textContent = data.name;

        const time = document.createElement("div");
        time.className = "user-time";
        time.textContent = formatTime(data.updatedAt);

        meta.append(name, time);
        li.append(avatar, meta);

        if (id === myId) {
            const tag = document.createElement("span");
            tag.className = "you-tag";
            tag.textContent = "شما";
            li.appendChild(tag);
        }

        userList.appendChild(li);
    }
}

// ارسال موقعیت GPS به پایگاه داده
async function publishPosition(position) {
    if (sending || watchId === null) return;

    sending = true;

    try {
        const {
            latitude,
            longitude,
            accuracy
        } = position.coords;

        const now = new Date().toISOString();

        const row = {
            id: myId,
            user_name: getUserName(),
            lat: latitude,
            lng: longitude,
            accuracy: Math.round(accuracy),
            updated_at: now
        };

        showMarker(
            myId,
            row.lat,
            row.lng,
            row.user_name,
            true,
            now
        );

        lastPosition = [row.lat, row.lng];
        centerBtn.disabled = false;

        const { error } = await supabase
            .from("trackers")
            .upsert(row, { onConflict: "id" });

        if (error) throw error;

        setStatus("در حال اشتراک‌گذاری", true);

        showNotice(
            "موقعیت شما با دقت تقریبی " +
            Math.round(accuracy) +
            " متر به‌روزرسانی شد.",
            "success"
        );

    } catch (error) {
        console.error("خطا در ارسال موقعیت:", error);

        showNotice(
            "ارسال موقعیت ناموفق بود. اتصال اینترنت و تنظیمات Supabase را بررسی کنید.",
            "error"
        );

        setStatus("خطا در ارسال");

    } finally {
        sending = false;
    }
}

// مدیریت خطاهای GPS
function handleGeoError(error) {
    const messages = {
        1: "دسترسی به موقعیت رد شد. مجوز مکان‌یابی مرورگر را فعال کنید.",
        2: "موقعیت پیدا نشد. GPS یا سرویس مکان‌یابی را بررسی کنید.",
        3: "دریافت موقعیت بیش از حد طول کشید. دوباره تلاش کنید."
    };

    showNotice(
        messages[error.code] ||
        "خطای ناشناخته در دریافت موقعیت.",
        "error"
    );

    setStatus("مکان‌یابی ناموفق");

    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
    }

    watchId = null;
    startBtn.disabled = false;
    stopBtn.disabled = true;
}

// دریافت کاربران قبلی از دیتابیس
async function loadExisting() {
    const { data, error } = await supabase
        .from("trackers")
        .select("id,user_name,lat,lng,updated_at");

    if (error) {
        console.error("خطا در دریافت کاربران:", error);

        showNotice(
            "خواندن کاربران ناموفق بود. دسترسی جدول Supabase را بررسی کنید.",
            "error"
        );

        return;
    }

    const cutoff = Date.now() - 2 * 60 * 60 * 1000;

    for (const row of data || []) {
        if (row.id === myId) continue;

        if (
            row.updated_at &&
            new Date(row.updated_at).getTime() < cutoff
        ) {
            continue;
        }

        showMarker(
            row.id,
            row.lat,
            row.lng,
            row.user_name,
            false,
            row.updated_at
        );
    }
}

// اتصال به رویدادهای زنده Supabase
const channel = supabase
    .channel("trackers-live")
    .on(
        "postgres_changes",
        {
            event: "*",
            schema: "public",
            table: "trackers"
        },
        ({ eventType, new: row, old }) => {
            if (eventType === "DELETE") {
                if (old && old.id) {
                    removeMarker(old.id);
                }
                return;
            }

            if (!row || !row.id || row.id === myId) {
                return;
            }

            showMarker(
                row.id,
                row.lat,
                row.lng,
                row.user_name,
                false,
                row.updated_at
            );
        }
    )
    .subscribe((state) => {
        if (state === "SUBSCRIBED") {
            if (watchId === null) {
                setStatus("متصل به سرور");
            }
        }

        if (
            state === "CHANNEL_ERROR" ||
            state === "TIMED_OUT"
        ) {
            setStatus("اختلال در ارتباط");
            showNotice(
                "ارتباط زنده با سرور برقرار نیست.",
                "error"
            );
        }
    });

// شروع ردیابی
startBtn.addEventListener("click", () => {
    if (!navigator.geolocation) {
        showNotice(
            "مرورگر شما از مکان‌یابی پشتیبانی نمی‌کند.",
            "error"
        );
        return;
    }

    if (
        !window.isSecureContext &&
        location.hostname !== "localhost"
    ) {
        showNotice(
            "برای استفاده از GPS، سایت باید HTTPS داشته باشد یا روی localhost اجرا شود.",
            "error"
        );
        return;
    }

    if (watchId !== null) return;

    startBtn.disabled = true;
    stopBtn.disabled = false;

    setStatus("در انتظار GPS");
    showNotice("در انتظار دریافت موقعیت دستگاه...");

    watchId = navigator.geolocation.watchPosition(
        publishPosition,
        handleGeoError,
        {
            enableHighAccuracy: true,
            maximumAge: 5000,
            timeout: 20000
        }
    );
});

// توقف ردیابی و حذف موقعیت از سرور
async function stopTracking() {
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
    }

    watchId = null;
    startBtn.disabled = false;
    stopBtn.disabled = true;

    setStatus("متوقف شد");

    showNotice(
        "اشتراک‌گذاری متوقف شد؛ در حال حذف موقعیت شما..."
    );

    const { error } = await supabase
        .from("trackers")
        .delete()
        .eq("id", myId);

    removeMarker(myId);

    lastPosition = null;
    centerBtn.disabled = true;

    if (error) {
        console.error("خطا در حذف موقعیت:", error);

        showNotice(
            "ردیابی متوقف شد، اما حذف موقعیت از سرور ناموفق بود. دسترسی جدول را بررسی کنید.",
            "error"
        );
    } else {
        showNotice(
            "ردیابی متوقف و موقعیت ذخیره‌شده شما حذف شد.",
            "success"
        );
    }
}

stopBtn.addEventListener("click", stopTracking);

// رفتن به موقعیت خود
centerBtn.addEventListener("click", () => {
    if (lastPosition) {
        map.setView(lastPosition, 16, {
            animate: true
        });
    }
});

// تغییر نام نمایشی در نشانگر خود
nameInput.addEventListener("change", () => {
    const own = markers.get(myId);

    if (!own) return;

    const point = own.marker.getLatLng();

    showMarker(
        myId,
        point.lat,
        point.lng,
        getUserName(),
        true,
        own.updatedAt
    );
});

// بارگذاری اولیه
renderUsers();
loadExisting();
