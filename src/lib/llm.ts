import axios from 'axios';

interface LLMRequestBody {
  model: string;
  messages: {
    role: string;
    content: string;
  }[];
  stream: boolean;
  format?: string;
}

interface LLMResponse {
  message: {
    content: string;
  };
}

/**
 * Call the LLM with a prompt and return the result
 * @param prompt - The prompt to send to the LLM
 * @param formatAsJson - Whether to request JSON formatted output
 * @returns The LLM response
 */
export async function callLLM(prompt: string, formatAsJson = false): Promise<any> {
  try {
    const url = 'http://localhost:11434/api/chat';
    
    const requestBody: LLMRequestBody = {
      model: 'llama3.2',
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      stream: false
    };
    
    // Add JSON format flag if requested
    if (formatAsJson) {
      requestBody.format = 'json';
    }
    
    const response = await axios.post<LLMResponse>(url, requestBody, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.data.message?.content) {
      throw new Error('Invalid response from LLM API');
    }
    
    // Parse JSON response if requested
    if (formatAsJson) {
      try {
        return JSON.parse(response.data.message.content);
      } catch (e) {
        console.error('Failed to parse JSON from LLM response:', e);
        console.log('Raw response:', response.data.message.content);
        throw new Error('Failed to parse JSON from LLM response');
      }
    }
    
    return response.data.message.content;
  } catch (error) {
    console.error('Error calling LLM:', error);
    throw error;
  }
}