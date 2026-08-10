/**
 * access-denied.js
 * Controller for access-denied.html. Distinguishes "pending" (never
 * approved yet) from "disabled" (admin revoked access) in the message,
 * and offers a sign-out (useful if they want to try a different Google
 * account, or once an admin tells them they've been approved and they
 * need a fresh session to pick up the change).
 */
import { getProfile, isAccessExpired, signOut } from "./auth.js?v=5";
import { hidePageLoader } from "./utils.js?v=6";

const statusHeading = document.getElementById("statusHeading");
const statusMessage = document.getElementById("statusMessage");
const signOutBtn = document.getElementById("signOutBtn");

async function init() {
  const profile = await getProfile();
  if (!profile) {
    // No session at all — just send them to login instead of showing this page.
    window.location.href = "login.html";
    return;
  }
  if (profile.status === "disabled") {
    statusHeading.textContent = "Access disabled";
    statusMessage.textContent = "Your account access has been disabled. Please contact your administrator.";
  } else if (isAccessExpired(profile)) {
    statusHeading.textContent = "Access expired";
    const expiredDate = new Date(profile.access_expires_at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    statusMessage.textContent = `Your access to this mock-test platform expired on ${expiredDate}. Please contact your administrator to renew your access.`;
  }
  // else: status === "pending" — falls through to the original "Access not approved" copy already in the HTML, unchanged.
  signOutBtn.addEventListener("click", async () => {
    await signOut();
    window.location.href = "login.html";
  });
  hidePageLoader();
}

init();
