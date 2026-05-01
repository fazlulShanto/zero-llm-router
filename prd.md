i want to create a llm client routing library.
# Problem: 
I use only free api for different providers. They have varity of limits like  
- token per day/week/month
- request per second/minute/day
- differnt provider have different models
- different model have different capability, response format, resoaning effort
- different model have different parameter
- sometimes free api gets timeout or error
- we need to reroute the request to another provider
- but the same model might not be avialable to the new provider, so we need a list of fallback provider & model configs
- we will use vercel's ai sdk to abstract the providers
- this library will be used to simplify the process of using different providers and models by defining a set of rules and configs. will act like load balancer for llms to increase the reliability and availability.
- we want to give user as flexible as possible to define rules and configs.
- we might need a local cache to store the model configs and their limits and update it & save it when request happens.

# Solution:
create a library that will route requests to different providers based on the limits.

user will create a client instance of our package by passing base config.
in the config they can give primary model config and a list of fallback model configs.
user should be able to use the client like normal ai sdk client

