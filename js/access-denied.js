/**
 * access-denied.js
 * Controller for access-denied.html. Distinguishes "pending" (never
 * approved yet) from "disabled" (admin revoked access) in the message,
 * and offers a sign-out (useful if they want to try a different Google
 * account, or once an admin tells them they've been approved and they
 * need a fresh session to pick up the change).
 */
import { getProfile, signOut } from "./auth.js?v=4";
import { hidePageLoader } from "./utils.js?v=5";

const statusMessage = document.getElementById("statusMessage");
const signOutBtn = document.getElementById("signOutBtn");

async function init() {
  const profile = await getProfile();
  if (profile?.status === "disabled") {
    statusMessage.textContent = "Your access to this platform has been disabled. Please contact the administrator.";
  } else if (!profile) {
    // No session at all — just send them to login instead of showing this page.
    window.location.href = "login.html";
    return;
  }
  signOutBtn.addEventListener("click", async () => {
    await signOut();
    window.location.href = "login.html";
  });
  hidePageLoader();
}

init();
