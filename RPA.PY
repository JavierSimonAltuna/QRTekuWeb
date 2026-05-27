import pyautogui
import time

print("Pincha dentro de la ventana AS400.")
print("Empiezo en 5 segundos...")
time.sleep(5)

pyautogui.write("26/05/2026", interval=0.05)
pyautogui.press("tab")
pyautogui.write("6265", interval=0.05)
pyautogui.press("enter")