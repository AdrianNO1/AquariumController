import os, requests, dotenv, time
dotenv.load_dotenv()

last_sms_times = []

def sms_alert(message):
    try:
        account_sid = os.environ.get("TWILIO_ACCOUNT_SID")
        auth_token = os.environ.get("TWILIO_AUTH_TOKEN")
        from_number = os.environ.get("TWILIO_FROM_NUMBER")
        to_number = os.environ.get("TWILIO_TO_NUMBER")

        print(account_sid, auth_token)
        if not account_sid or not auth_token:
            raise Exception("TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not set")
        else:
            url = f"https://api.twilio.com/2010-04-01/Accounts/{account_sid}/Messages.json"

            data = {
                "To": to_number,
                "From": from_number,
                "Body": message
            }

            if len(last_sms_times) > 1:
                if last_sms_times[0] > time.time() - 25000:
                    print("#"*50)
                    print("Skipping SMS because of rate limit")
                    print(last_sms_times)
                    print("#"*50)
                    return
                else:
                    last_sms_times.pop(0)
            last_sms_times.append(time.time())

            # Make POST request with basic auth
            response = requests.post(url, data=data, auth=(account_sid, auth_token))

            print(response.status_code)
            print(response.json())
    except Exception as e:
        print(f"Error sending SMS: {str(e)}")