// PULSO · Firebase Auth module
// Gestiona autenticación Google/Microsoft SSO.
// Requiere Firebase SDK cargado vía /__/firebase/init.js
(function () {
  "use strict";

  var _authReady = false;
  var _currentUser = null;
  var _callbacks = [];

  function _notify(user) {
    _currentUser = user;
    _authReady = true;
    _callbacks.slice().forEach(function (cb) { try { cb(user); } catch (e) {} });
  }

  function _initAuth() {
    if (!window.firebase) {
      console.warn("[PulsoAuth] Firebase SDK no disponible");
      _notify(null);
      return;
    }
    firebase.auth().onAuthStateChanged(function (user) {
      _notify(user);
    });
  }

  async function getIdToken() {
    if (!_currentUser) return null;
    try {
      return await _currentUser.getIdToken(false);
    } catch (e) {
      console.warn("[PulsoAuth] getIdToken:", e);
      return null;
    }
  }

  async function signInWithGoogle() {
    if (!window.firebase) throw new Error("Firebase SDK no disponible");
    var provider = new firebase.auth.GoogleAuthProvider();
    return firebase.auth().signInWithPopup(provider);
  }

  async function signInWithMicrosoft() {
    if (!window.firebase) throw new Error("Firebase SDK no disponible");
    var provider = new firebase.auth.OAuthProvider("microsoft.com");
    return firebase.auth().signInWithPopup(provider);
  }

  async function signOut() {
    if (!window.firebase) return;
    return firebase.auth().signOut();
  }

  function onAuthStateChanged(cb) {
    _callbacks.push(cb);
    if (_authReady) {
      try { cb(_currentUser); } catch (e) {}
    }
  }

  function getCurrentUser() { return _currentUser; }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _initAuth);
  } else {
    _initAuth();
  }

  window.PulsoAuth = {
    getIdToken: getIdToken,
    signInWithGoogle: signInWithGoogle,
    signInWithMicrosoft: signInWithMicrosoft,
    signOut: signOut,
    onAuthStateChanged: onAuthStateChanged,
    getCurrentUser: getCurrentUser,
  };
})();
