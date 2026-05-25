// Sample data based on the real Excel columns used by QRTeku
window.QRTEKU_ROWS = [
  { destino: "TARRAGONA",  u: "T", orden: "451208", n: "245", agencia: "BLEECKER",       matriculas: "8741JKM / R-9821CDP", tipo: "TAUTLINER", expedicion: "EXP-25-04812", y: "Y", cad: "CAD-7741", precinto: "G-552781", estado: "ready" },
  { destino: "BARCELONA",  u: "T", orden: "451211", n: "246", agencia: "TRANSDEL IBÉRICA", matriculas: "2294LMN / R-4471BWX", tipo: "FRIGORÍFICO",   expedicion: "EXP-25-04813", y: "Y", cad: "CAD-7742", precinto: "G-552782, G-552783", estado: "ready" },
  { destino: "SAGUNTO",    u: "T", orden: "451213", n: "247", agencia: "BLEECKER",       matriculas: "6173HZP / R-1108RPL", tipo: "CISTERNA",   expedicion: "EXP-25-04814", y: "Y", cad: "CAD-7743", precinto: "G-552784", estado: "ready" },
  { destino: "BILBAO",     u: "T", orden: "451215", n: "248", agencia: "LOGISTRANS",     matriculas: "0852VYC / R-3340FLK", tipo: "TAUTLINER", expedicion: "EXP-25-04815", y: "Y", cad: "CAD-7744", precinto: "G-552785", estado: "ready" },
  { destino: "ALGECIRAS",  u: "T", orden: "451218", n: "249", agencia: "IBERIA TRANS",   matriculas: "9437BJM / R-2018HRT", tipo: "FRIGORÍFICO",   expedicion: "EXP-25-04816", y: "Y", cad: "CAD-7745", precinto: "G-552786", estado: "ready" },
  { destino: "VALENCIA",   u: "T", orden: "451220", n: "250", agencia: "BLEECKER",       matriculas: "5503KPN / R-7782VCS", tipo: "TAUTLINER", expedicion: "EXP-25-04817", y: "Y", cad: "CAD-7746", precinto: "G-552787, G-552788, G-552789", estado: "ready" },
  { destino: "GIJÓN",      u: "T", orden: "451222", n: "251", agencia: "TRANSDEL IBÉRICA", matriculas: "1166ZRT / R-8893QML", tipo: "TAUTLINER", expedicion: "EXP-25-04818", y: "Y", cad: "CAD-7747", precinto: "G-552790", estado: "ready" },
  { destino: "SEVILLA",    u: "T", orden: "451225", n: "252", agencia: "LOGISTRANS",     matriculas: "4421GHB / R-5527NCK", tipo: "CISTERNA",   expedicion: "EXP-25-04819", y: "Y", cad: "CAD-7748", precinto: "G-552791", estado: "missing-cif" },
  { destino: "MADRID",     u: "T", orden: "451227", n: "253", agencia: "BLEECKER",       matriculas: "7783QWE / R-4416LMP", tipo: "FRIGORÍFICO",   expedicion: "EXP-25-04820", y: "Y", cad: "CAD-7749", precinto: "G-552792", estado: "ready" },
  { destino: "TARRAGONA",  u: "T", orden: "451230", n: "254", agencia: "IBERIA TRANS",   matriculas: "2256FRS / R-9905TYU", tipo: "TAUTLINER", expedicion: "EXP-25-04821", y: "Y", cad: "CAD-7750", precinto: "G-552793", estado: "done" },
  { destino: "BILBAO",     u: "T", orden: "451231", n: "255", agencia: "TRANSDEL IBÉRICA", matriculas: "0034VBN / R-3318KJH", tipo: "CISTERNA",   expedicion: "EXP-25-04822", y: "Y", cad: "CAD-7751", precinto: "G-552794", estado: "done" },
  { destino: "VALENCIA",   u: "T", orden: "451233", n: "256", agencia: "BLEECKER",       matriculas: "9981PLO / R-2245MNB", tipo: "TAUTLINER", expedicion: "EXP-25-04823", y: "Y", cad: "CAD-7752", precinto: "G-552795", estado: "ready" },
];

window.QRTEKU_SAMPLE_PAYLOAD = {
  T: "8741JKM",
  R: "9821CDP",
  N: "245",
  D: "20260519",
  C: "B61234567",
  E: "BLEECKER",
  P: [
    { H: "08:14", D: "Carga iniciada por turno mañana" },
    { H: "09:02", D: "Verificación precinto OK" }
  ]
};
