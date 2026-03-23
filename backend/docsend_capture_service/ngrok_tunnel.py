import os
from dotenv import load_dotenv
load_dotenv()

from pyngrok import ngrok, conf

conf.get_default().auth_token = os.getenv("NGROK_AUTHTOKEN")
tunnel = ngrok.connect(8501)
print(f"ngrok tunnel: {tunnel.public_url}")

ngrok.get_ngrok_process().proc.wait()
